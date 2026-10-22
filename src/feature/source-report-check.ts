import * as core from '@actions/core';
import * as github from '@actions/github';
import { IssuesEvent } from '@octokit/webhooks-types/schema';

import { GitHubClient } from '../types';
import { write } from '../util/dry-run';
import { fetchExtensionIndex, knownLanguages } from '../util/extension-index';
import {
  Report,
  extensionDirectory,
  guessedDirectories,
  parseReport,
  resolveExtension,
} from '../util/extension-resolver';
import { addDuplicateLabel, shouldIgnore } from '../util/issues';
import {
  IssueParameters,
  fillTemplate,
  hasMarker,
  jsonInput,
  labelNames,
  withFooter,
} from '../util/source-reports';

const NOT_FOUND = 'source-check:not-found';

/**
 * Check that a source report names an extension that exists.
 *
 * - No extension matches, but one with that name was removed before: label it and close.
 * - No extension matches at all: ask for the name as shown in the app and close.
 * - The extension already has an open `Site Issues` issue: close as a duplicate of it.
 * - The reporter fixes a closed report by editing it: reopen.
 */
export async function checkSourceReport() {
  const payload = github.context.payload as IssuesEvent;
  if (!['opened', 'edited'].includes(payload.action)) {
    core.info('Irrelevant action trigger');
    return;
  }

  if (core.getInput('source-check-enabled') !== 'true') {
    core.info('SKIP: the source check is disabled');
    return;
  }

  const client = github.getOctokit(core.getInput('repo-token', { required: true }));
  const { repo } = github.context;
  const params = { owner: repo.owner, repo: repo.repo, issue_number: payload.issue.number };

  // The other checks run first and may have closed or relabelled the issue.
  const { data: issue } = await client.rest.issues.get(params);
  const labels = labelNames(issue.labels);
  if (await shouldIgnore(labels)) return;

  const checkLabels = jsonInput('source-check-labels');
  if (!labels.some((l) => checkLabels.includes(l))) {
    core.info('SKIP: no source check label set');
    return;
  }
  // e.g. source requests closed as "Source is down": not about an existing extension.
  const excluded = labels.find((l) => jsonInput('source-check-exclude-labels').includes(l));
  if (excluded) {
    core.info(`SKIP: labelled ${excluded}`);
    return;
  }

  const extensions = await fetchExtensionIndex();
  if (!extensions) return;

  const report = parseReport(issue.title, issue.body ?? null);
  const resolution = resolveExtension(extensions, report);
  core.info(
    `Reported "${report.name}" resolved as ${resolution.kind}${'extension' in resolution ? `: ${extensionDirectory(resolution.extension)}` : ''}`,
  );

  if (issue.state === 'closed') {
    // Only reopen what this check closed, once the edit makes it resolvable.
    if (
      payload.action === 'edited' &&
      resolution.kind !== 'none' &&
      (await hasMarker(client, params, NOT_FOUND))
    ) {
      await write(`Reopen #${issue.number}: the edited report now matches an extension`, () =>
        client.rest.issues.update({ ...params, state: 'open' }),
      );
    }
    return;
  }

  if (resolution.kind === 'none') {
    await closeUnknownSource(client, params, report, knownLanguages(extensions));
    return;
  }

  if (resolution.kind !== 'ambiguous' && payload.action === 'opened') {
    await closeIfSiteIssueTracked(
      client,
      params,
      extensionDirectory(resolution.extension),
      resolution.extension.name,
      extensions,
    );
  }
}

async function closeUnknownSource(
  client: GitHubClient,
  params: IssueParameters,
  report: Report,
  languages: string[],
) {
  const removed = await findRemovedDirectory(client, params, report, languages);
  if (removed) {
    const label = core.getInput('previously-deleted-label');
    const body = fillTemplate(core.getInput('source-check-previously-deleted-comment'), {
      reportedName: report.name,
      commitUrl: removed.commitUrl,
    });
    await write(`Close #${params.issue_number}: "${report.name}" was removed in ${removed.commitUrl}`, async () => {
      if (label) await client.rest.issues.addLabels({ ...params, labels: [label] });
      await client.rest.issues.createComment({ ...params, body: withFooter(body, 'source-check:removed') });
      await client.rest.issues.update({ ...params, state: 'closed', state_reason: 'not_planned' });
    });
    return;
  }

  const body = fillTemplate(core.getInput('source-check-not-found-comment'), {
    reportedName: report.name,
  });
  await write(`Close #${params.issue_number}: no extension matches "${report.name}"`, async () => {
    await client.rest.issues.createComment({ ...params, body: withFooter(body, NOT_FOUND) });
    await client.rest.issues.update({ ...params, state: 'closed', state_reason: 'not_planned' });
  });
}

/**
 * Directory names are the extension name in lowercase letters and digits for most extensions,
 * so a deleted directory with that name is a removed extension.
 */
async function findRemovedDirectory(
  client: GitHubClient,
  params: IssueParameters,
  report: Report,
  languages: string[],
): Promise<{ path: string; commitUrl: string } | undefined> {
  for (const path of guessedDirectories(report, languages)) {
    const { data: commits } = await client.rest.repos.listCommits({
      owner: params.owner,
      repo: params.repo,
      path,
      per_page: 1,
    });
    if (commits.length === 0) continue;
    try {
      await client.rest.repos.getContent({ owner: params.owner, repo: params.repo, path });
    } catch (error: any) {
      if (error.status === 404) return { path, commitUrl: commits[0].html_url };
      throw error;
    }
  }
  return undefined;
}

async function closeIfSiteIssueTracked(
  client: GitHubClient,
  params: IssueParameters,
  directory: string,
  extensionName: string,
  extensions: Awaited<ReturnType<typeof fetchExtensionIndex>> & {},
) {
  const siteIssuesLabel = core.getInput('site-issues-label');
  if (!siteIssuesLabel) return;

  const tracked = await client.paginate(client.rest.issues.listForRepo, {
    owner: params.owner,
    repo: params.repo,
    labels: siteIssuesLabel,
    state: 'open',
    per_page: 100,
  });
  const existing = tracked.find((other) => {
    if (other.number === params.issue_number || other.pull_request) return false;
    const r = resolveExtension(extensions, parseReport(other.title, other.body ?? null));
    return r.kind !== 'none' && r.kind !== 'ambiguous' && extensionDirectory(r.extension) === directory;
  });
  if (!existing) return;

  const body = fillTemplate(core.getInput('site-issues-duplicate-comment'), {
    extensionName,
    issueNumber: `${existing.number}`,
  });
  await write(`Close #${params.issue_number} as a duplicate of site issue #${existing.number}`, async () => {
    await addDuplicateLabel(client, params);
    await client.rest.issues.createComment({ ...params, body: withFooter(body, 'source-check:site-issue') });
    await client.rest.issues.update({ ...params, state: 'closed', state_reason: 'duplicate' });
  });
}

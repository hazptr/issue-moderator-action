import * as core from '@actions/core';
import * as github from '@actions/github';

import { GitHubClient } from '../types';
import { formatEvidence, domainEvidence } from '../util/domain-evidence';
import { isDryRun, write } from '../util/dry-run';
import { fetchExtensionIndex } from '../util/extension-index';
import {
  IndexExtension,
  cleanHost,
  extensionDirectory,
  parseReport,
  resolveExtension,
} from '../util/extension-resolver';
import {
  IssueParameters,
  fillTemplate,
  hasMarker,
  jsonInput,
  labelNames,
  marker,
  withFooter,
} from '../util/source-reports';

const DAY = 24 * 60 * 60 * 1000;

export function removalBranch(extension: IndexExtension): string {
  const [, lang, dir] = extensionDirectory(extension).split('/');
  return `bot/remove/${lang}-${dir}`;
}

export function isDue(labeledAt: Date, now: Date, days: number): boolean {
  return now.getTime() - labeledAt.getTime() >= days * DAY;
}

/** Labels that keep an issue away from automatic removal. */
export function removalBlockers(): string[] {
  return [
    ...jsonInput('removal-exclude-labels'),
    core.getInput('disputed-label'),
    core.getInput('site-issues-label'),
    core.getInput('auto-close-ignore-label'),
  ].filter(Boolean);
}

function prClient(): GitHubClient {
  const token = core.getInput('pr-token') || core.getInput('repo-token', { required: true });
  return github.getOctokit(token);
}

/** When the down label was last added; relabelled bug reports count from the relabel. */
async function labeledAt(
  client: GitHubClient,
  params: IssueParameters,
  label: string,
  createdAt: string,
): Promise<Date> {
  const events = await client.paginate(client.rest.issues.listEvents, { ...params, per_page: 100 });
  const last = events
    .filter((e: any) => e.event === 'labeled' && e.label?.name === label)
    .pop();
  return new Date(last?.created_at ?? createdAt);
}

/**
 * Daily: open removal PRs for down reports that stayed open for `removal-days`,
 * and close source requests whose site stayed down as long.
 */
export async function checkForSourceRemovals() {
  if (core.getInput('removal-enabled') !== 'true') {
    core.info('SKIP: automatic source removal is disabled');
    return;
  }

  const downLabel = core.getInput('source-down-label', { required: true });
  const days = Number(core.getInput('removal-days') || '14');
  const blockers = removalBlockers();
  const requestLabel = core.getInput('source-request-label');
  const requestBlockers = [core.getInput('disputed-label'), core.getInput('auto-close-ignore-label')].filter(Boolean);
  const extensions = await fetchExtensionIndex();
  if (!extensions) return;

  const client = github.getOctokit(core.getInput('repo-token', { required: true }));
  const { repo } = github.context;
  const now = new Date();

  const issues = await client.paginate(client.rest.issues.listForRepo, {
    owner: repo.owner,
    repo: repo.repo,
    labels: downLabel,
    state: 'open',
    per_page: 100,
  });

  for (const issue of issues) {
    if (issue.pull_request) continue;
    const params = { owner: repo.owner, repo: repo.repo, issue_number: issue.number };
    const labels = labelNames(issue.labels);
    // A requested site that went down: there is no extension to remove, only the request to close.
    const isRequest = !!requestLabel && labels.includes(requestLabel);
    const blocker = labels.find((l) => (isRequest ? requestBlockers : blockers).includes(l));
    if (blocker) {
      core.info(`#${issue.number}: skipped, labelled ${blocker}`);
      continue;
    }

    const since = await labeledAt(client, params, downLabel, issue.created_at);
    if (!isDue(since, now, days)) {
      core.info(`#${issue.number}: ${Math.floor((now.getTime() - since.getTime()) / DAY)} of ${days} days`);
      continue;
    }

    if (isRequest) {
      const body = withFooter(
        fillTemplate(core.getInput('source-request-down-comment'), { days: `${days}` }),
        'source-removal:request-closed',
      );
      await write(`Close source request #${issue.number}: site down for ${days} days`, async () => {
        await client.rest.issues.createComment({ ...params, body });
        await client.rest.issues.update({ ...params, state: 'closed', state_reason: 'not_planned' });
      });
      continue;
    }

    const resolution = resolveExtension(extensions, parseReport(issue.title, issue.body ?? null));
    if (resolution.kind === 'none') {
      core.info(`#${issue.number}: no matching extension`);
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      const names = resolution.candidates.map((e) => `**${e.name}** (\`${extensionDirectory(e)}\`)`);
      if (!(await hasMarker(client, params, 'source-removal:ambiguous'))) {
        const body = withFooter(
          `This report matches more than one extension, so it was not removed automatically: ${names.join(', ')}. A maintainer can comment \`/remove <package name>\` to remove one.`,
          'source-removal:ambiguous',
        );
        await write(`Comment on #${issue.number}: ambiguous between ${names.length} extensions`, () =>
          client.rest.issues.createComment({ ...params, body }),
        );
      }
      continue;
    }

    const directory = extensionDirectory(resolution.extension);
    const { data: commits } = await client.rest.repos.listCommits({
      owner: repo.owner,
      repo: repo.repo,
      path: directory,
      since: since.toISOString(),
      per_page: 1,
    });
    if (commits.length) {
      // Someone worked on the extension after the report, usually a fix: leave it to a maintainer.
      if (!(await hasMarker(client, params, 'source-removal:changed'))) {
        const body = withFooter(
          `**${resolution.extension.name}** was changed after this report (${commits[0].html_url}), so it was not removed automatically. If the source is still down, a maintainer can comment \`/remove\`.`,
          'source-removal:changed',
        );
        await write(`Comment on #${issue.number}: extension changed since the report`, () =>
          client.rest.issues.createComment({ ...params, body }),
        );
      }
      continue;
    }

    await openRemovalPullRequest(resolution.extension, [issue.number], since);
  }
}

/**
 * Open (or extend) the PR that deletes an extension's directory.
 */
export async function openRemovalPullRequest(
  extension: IndexExtension,
  issueNumbers: number[],
  reportedSince?: Date,
) {
  const client = prClient();
  const { repo } = github.context;
  const branch = removalBranch(extension);
  const directory = extensionDirectory(extension);
  const closes = issueNumbers.map((n) => `Closes #${n}`);

  const { data: open } = await client.rest.pulls.list({
    owner: repo.owner,
    repo: repo.repo,
    head: `${repo.owner}:${branch}`,
    state: 'open',
  });
  if (open.length) {
    const pr = open[0];
    const missing = closes.filter((line) => !pr.body?.includes(line));
    if (missing.length === 0) {
      core.info(`PR #${pr.number} already removes ${directory}`);
      return;
    }
    await write(`Add ${missing.join(', ')} to PR #${pr.number}`, () =>
      client.rest.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pr.number,
        body: `${missing.join('\n')}\n${pr.body ?? ''}`,
      }),
    );
    return;
  }

  const host = cleanHost(extension.sources[0].homeUrl);
  const evidence = await domainEvidence(host);
  const sourceList = extension.sources
    .map((s) => `- ${s.name} (${s.language}): ${s.homeUrl}`)
    .join('\n');
  const body = [
    ...closes,
    '',
    `Removes **${extension.name}** (\`${directory}\`).${reportedSince ? ` Reported down since ${reportedSince.toISOString().slice(0, 10)} with no fix in the meantime.` : ''}`,
    '',
    sourceList,
    '',
    'Domain check (public DNS and RDAP, the site itself was not contacted):',
    formatEvidence(evidence),
    '',
    '*Opened automatically. Comment `Source is not down` on the report if the source still works.*',
    marker('source-removal:pr'),
  ].join('\n');

  if (isDryRun()) {
    core.info(`[dry-run] Open PR "Remove ${extension.name}" from ${branch}:\n${body}`);
    return;
  }

  const { data: repository } = await client.rest.repos.get({ owner: repo.owner, repo: repo.repo });
  const base = repository.default_branch;
  const { data: ref } = await client.rest.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${base}` });
  const { data: baseCommit } = await client.rest.git.getCommit({
    owner: repo.owner,
    repo: repo.repo,
    commit_sha: ref.object.sha,
  });

  const files = await directoryFiles(client, baseCommit.tree.sha, directory);
  if (files.length === 0) {
    core.warning(`${directory} does not exist on ${base}`);
    return;
  }
  const { data: tree } = await client.rest.git.createTree({
    owner: repo.owner,
    repo: repo.repo,
    base_tree: baseCommit.tree.sha,
    tree: files.map((f) => ({ path: f.path, mode: f.mode, type: 'blob' as const, sha: null })),
  });
  const { data: commit } = await client.rest.git.createCommit({
    owner: repo.owner,
    repo: repo.repo,
    message: `Remove ${extension.name}`,
    tree: tree.sha,
    parents: [ref.object.sha],
  });

  try {
    await client.rest.git.createRef({ owner: repo.owner, repo: repo.repo, ref: `refs/heads/${branch}`, sha: commit.sha });
  } catch (error: any) {
    if (error.status !== 422) throw error;
    // Left over from an earlier, closed PR.
    await client.rest.git.updateRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${branch}`, sha: commit.sha, force: true });
  }

  const { data: pr } = await client.rest.pulls.create({
    owner: repo.owner,
    repo: repo.repo,
    title: `Remove ${extension.name}`,
    head: branch,
    base,
    body,
  });
  core.info(`Opened PR #${pr.number} removing ${directory}`);
}

/** Every file path under a directory, walking the tree one level at a time. */
type FileMode = '100644' | '100755' | '120000';

async function directoryFiles(
  client: GitHubClient,
  rootTree: string,
  directory: string,
): Promise<{ path: string; mode: FileMode }[]> {
  const { repo } = github.context;
  let sha = rootTree;
  for (const part of directory.split('/')) {
    const { data } = await client.rest.git.getTree({ owner: repo.owner, repo: repo.repo, tree_sha: sha });
    const entry = data.tree.find((e) => e.path === part && e.type === 'tree');
    if (!entry?.sha) return [];
    sha = entry.sha;
  }
  const { data } = await client.rest.git.getTree({
    owner: repo.owner,
    repo: repo.repo,
    tree_sha: sha,
    recursive: 'true',
  });
  return data.tree
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: `${directory}/${e.path}`, mode: e.mode as FileMode }));
}

/** Open removal PR for an extension, if any. */
export async function findRemovalPullRequest(extension: IndexExtension) {
  const client = prClient();
  const { repo } = github.context;
  const { data } = await client.rest.pulls.list({
    owner: repo.owner,
    repo: repo.repo,
    head: `${repo.owner}:${removalBranch(extension)}`,
    state: 'open',
  });
  return data[0];
}

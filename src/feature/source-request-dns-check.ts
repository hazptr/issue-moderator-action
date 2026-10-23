import * as core from '@actions/core';
import * as github from '@actions/github';
import { IssuesEvent } from '@octokit/webhooks-types/schema';

import { GitHubClient } from '../types';
import { DomainEvidence, domainEvidence, domainIsGone } from '../util/domain-evidence';
import { write } from '../util/dry-run';
import { cleanHost } from '../util/extension-resolver';
import { shouldIgnore } from '../util/issues';
import {
  IssueParameters,
  fillTemplate,
  hasMarker,
  jsonInput,
  labelNames,
  withFooter,
} from '../util/source-reports';
import { urlsFromIssueBody } from '../util/urls';

const MARKED = 'request-dns:marked-down';
const DAY = 24 * 60 * 60 * 1000;
// "comics.html" or "feed.xml" in a pasted link look like hosts to the URL pattern.
const FILE_NAME = /\.(?:html?|php|aspx?|jsp|xml|json|txt|png|jpe?g|gif|webp|pdf|zip)$/;

interface RequestDomains {
  hosts: string[];
  evidence: DomainEvidence[];
  allGone: boolean;
}

async function requestDomains(body: string | null): Promise<RequestDomains | undefined> {
  const hosts = Array.from(
    new Set(urlsFromIssueBody(body ?? '', jsonInput('url-search-sections')).map(cleanHost)),
  ).filter((h) => !FILE_NAME.test(h));
  if (hosts.length === 0) return undefined;
  const evidence = await Promise.all(hosts.map(domainEvidence));
  core.info(evidence.map((e) => `${e.host}: ${domainIsGone(e) ? 'gone' : 'present'}`).join(', '));
  return { hosts, evidence, allGone: evidence.every(domainIsGone) };
}

async function markDown(client: GitHubClient, params: IssueParameters, domains: RequestDomains) {
  const downLabel = core.getInput('source-down-label');
  const body = fillTemplate(core.getInput('request-dns-down-comment'), {
    hosts: domains.hosts.map((h) => `\`${h}\``).join(', '),
    reason: domains.evidence.map(goneReason).join('; '),
    days: core.getInput('removal-days') || '14',
  });
  await write(`Label source request #${params.issue_number} ${downLabel}: ${domains.hosts.join(', ')} gone`, async () => {
    await client.rest.issues.addLabels({ ...params, labels: [downLabel] });
    await client.rest.issues.createComment({ ...params, body: withFooter(body, MARKED) });
  });
}

async function unmarkDown(client: GitHubClient, params: IssueParameters, why: string) {
  const downLabel = core.getInput('source-down-label');
  await write(`Remove ${downLabel} from #${params.issue_number}: ${why}`, () =>
    client.rest.issues.removeLabel({ ...params, name: downLabel }),
  );
}

/**
 * Check the domain of a new source request with public DNS and RDAP (never the site itself).
 * When every requested domain is gone, label the request as down, which starts the timer that
 * closes it. If an edit fixes the link, the label comes off again.
 */
export async function checkSourceRequestDomain() {
  const payload = github.context.payload as IssuesEvent;
  if (!['opened', 'edited'].includes(payload.action)) {
    core.info('Irrelevant action trigger');
    return;
  }

  if (core.getInput('request-dns-check-enabled') !== 'true') {
    core.info('SKIP: the source request domain check is disabled');
    return;
  }

  const requestLabel = core.getInput('source-request-label');
  const downLabel = core.getInput('source-down-label');
  if (!requestLabel || !downLabel) {
    core.info('SKIP: source-request-label and source-down-label are required');
    return;
  }

  const client = github.getOctokit(core.getInput('repo-token', { required: true }));
  const { repo } = github.context;
  const params = { owner: repo.owner, repo: repo.repo, issue_number: payload.issue.number };

  // Earlier checks may have closed it, e.g. as an existing source.
  const { data: issue } = await client.rest.issues.get(params);
  const labels = labelNames(issue.labels);
  if (issue.state !== 'open' || !labels.includes(requestLabel)) return;
  if (await shouldIgnore(labels)) return;

  const domains = await requestDomains(issue.body ?? null);
  if (!domains) {
    core.info('No URLs found in the request');
    return;
  }

  if (domains.allGone && !labels.includes(downLabel)) {
    await markDown(client, params, domains);
    return;
  }

  // The requester fixed the link: undo only what this check did.
  if (
    !domains.allGone &&
    payload.action === 'edited' &&
    labels.includes(downLabel) &&
    (await hasMarker(client, params, MARKED))
  ) {
    await unmarkDown(client, params, "the requested site's domain exists now");
  }
}

/** Which requests a run rechecks: each one every `days` days, picked by issue number. */
export function inRecheckBucket(issueNumber: number, now: Date, days: number): boolean {
  return days <= 1 || issueNumber % days === Math.floor(now.getTime() / DAY) % days;
}

/**
 * Daily: recheck the domains of open source requests, each one every `request-recheck-days` days.
 * Requests whose domains are all gone are marked down; ones this check marked get unmarked
 * when a domain is back. Labels added by people are left alone.
 */
export async function recheckSourceRequests() {
  const days = Number(core.getInput('request-recheck-days') || '0');
  const requestLabel = core.getInput('source-request-label');
  const downLabel = core.getInput('source-down-label');
  if (!days || !requestLabel || !downLabel) {
    core.info('SKIP: the source request recheck is disabled');
    return;
  }

  const client = github.getOctokit(core.getInput('repo-token', { required: true }));
  const { repo } = github.context;
  const skip = [core.getInput('disputed-label'), core.getInput('auto-close-ignore-label')].filter(Boolean);
  const now = new Date();

  const requests = await client.paginate(client.rest.issues.listForRepo, {
    owner: repo.owner,
    repo: repo.repo,
    labels: requestLabel,
    state: 'open',
    per_page: 100,
  });

  let checked = 0;
  for (const issue of requests) {
    if (issue.pull_request || !inRecheckBucket(issue.number, now, days)) continue;
    const labels = labelNames(issue.labels);
    if (labels.some((l) => skip.includes(l))) continue;

    const params = { owner: repo.owner, repo: repo.repo, issue_number: issue.number };
    const domains = await requestDomains(issue.body ?? null);
    checked++;
    if (!domains) continue;

    const wantsMark = domains.allGone && !labels.includes(downLabel);
    const wantsUnmark = !domains.allGone && labels.includes(downLabel);
    if (!wantsMark && !wantsUnmark) continue;

    // The label listing can lag; act on the issue as it is now.
    const { data: current } = await client.rest.issues.get(params);
    const currentLabels = labelNames(current.labels);
    if (current.state !== 'open' || currentLabels.some((l) => skip.includes(l))) continue;
    if (wantsMark && !currentLabels.includes(downLabel)) {
      await markDown(client, params, domains);
    } else if (wantsUnmark && currentLabels.includes(downLabel) && (await hasMarker(client, params, MARKED))) {
      await unmarkDown(client, params, "a requested site's domain exists again");
    }
  }
  core.info(`Rechecked ${checked} of ${requests.length} open source requests`);
}

function goneReason(e: DomainEvidence): string {
  if (e.dns === 'nxdomain') return `${e.host} does not exist`;
  if (e.registered === false) return `${e.host} has no DNS answer and no registration record`;
  return `${e.host} has no DNS answer and its registration expired on ${e.expires?.slice(0, 10)}`;
}

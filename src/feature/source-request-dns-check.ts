import * as core from '@actions/core';
import * as github from '@actions/github';
import { IssuesEvent } from '@octokit/webhooks-types/schema';

import { DomainEvidence, domainEvidence, domainIsGone } from '../util/domain-evidence';
import { write } from '../util/dry-run';
import { cleanHost } from '../util/extension-resolver';
import { shouldIgnore } from '../util/issues';
import { fillTemplate, hasMarker, jsonInput, labelNames, withFooter } from '../util/source-reports';
import { urlsFromIssueBody } from '../util/urls';

const MARKED = 'request-dns:marked-down';

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

  const hosts = Array.from(
    new Set(
      urlsFromIssueBody(issue.body ?? '', jsonInput('url-search-sections')).map(cleanHost),
    ),
  );
  if (hosts.length === 0) {
    core.info('No URLs found in the request');
    return;
  }

  const evidence = await Promise.all(hosts.map(domainEvidence));
  const allGone = evidence.every(domainIsGone);
  core.info(evidence.map((e) => `${e.host}: ${domainIsGone(e) ? 'gone' : 'present'}`).join(', '));

  if (allGone && !labels.includes(downLabel)) {
    const body = fillTemplate(core.getInput('request-dns-down-comment'), {
      hosts: hosts.map((h) => `\`${h}\``).join(', '),
      reason: evidence.map(goneReason).join('; '),
      days: core.getInput('removal-days') || '14',
    });
    await write(`Label source request #${issue.number} ${downLabel}: ${hosts.join(', ')} gone`, async () => {
      await client.rest.issues.addLabels({ ...params, labels: [downLabel] });
      await client.rest.issues.createComment({ ...params, body: withFooter(body, MARKED) });
    });
    return;
  }

  // The requester fixed the link: undo only what this check did.
  if (
    !allGone &&
    payload.action === 'edited' &&
    labels.includes(downLabel) &&
    (await hasMarker(client, params, MARKED))
  ) {
    await write(`Remove ${downLabel} from #${issue.number}: the requested site's domain exists now`, () =>
      client.rest.issues.removeLabel({ ...params, name: downLabel }),
    );
  }
}

function goneReason(e: DomainEvidence): string {
  if (e.dns === 'nxdomain') return `${e.host} does not resolve`;
  if (e.registered === false) return `${e.host} is not registered`;
  if (e.parked) return `${e.host} is parked (${e.nameservers[0]})`;
  return `${e.host}'s registration expired on ${e.expires?.slice(0, 10)}`;
}

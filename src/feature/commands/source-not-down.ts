import * as core from '@actions/core';
import * as github from '@actions/github';
import { IssueCommentEvent } from '@octokit/webhooks-types/schema';

import { GitHubClient } from '../../types';
import { write } from '../../util/dry-run';
import { fetchExtensionIndex } from '../../util/extension-index';
import { parseReport, resolveExtension } from '../../util/extension-resolver';
import { labelNames, withFooter } from '../../util/source-reports';
import { findRemovalPullRequest } from '../source-removal';

/**
 * Anyone can say a reported source still works. The reporter withdraws their report;
 * anyone else pauses the automatic removal until a maintainer looks.
 */
export async function sourceNotDown(client: GitHubClient, _commentBody: string) {
  const payload = github.context.payload as IssueCommentEvent;
  const { issue, comment } = payload;
  const params = { owner: github.context.repo.owner, repo: github.context.repo.repo, issue_number: issue.number };

  const downLabel = core.getInput('source-down-label');
  const disputedLabel = core.getInput('disputed-label');
  const labels = labelNames(issue.labels);
  if (core.getInput('removal-enabled') !== 'true' || !downLabel || !labels.includes(downLabel)) {
    core.info('SKIP: not a source down report');
    return;
  }
  if (issue.state !== 'open' || issue.pull_request) return;

  if (comment.user.login === issue.user.login) {
    const body = withFooter(
      `Closed because @${comment.user.login}, who reported it, says the source works again.`,
      'source-down:withdrawn',
    );
    await write(`Close #${issue.number}: withdrawn by the reporter`, async () => {
      await client.rest.issues.createComment({ ...params, body });
      await client.rest.issues.update({ ...params, state: 'closed', state_reason: 'not_planned' });
    });
    return;
  }

  if (labels.includes(disputedLabel)) {
    core.info('Already disputed');
    return;
  }

  const body = withFooter(
    `Thanks @${comment.user.login}. Automatic removal is paused until a maintainer checks this report. If only part of the extension fails because of the site, a maintainer can relabel it \`${core.getInput('site-issues-label')}\`.`,
    'source-down:disputed',
  );
  await write(`Label #${issue.number} ${disputedLabel}: disputed by @${comment.user.login}`, async () => {
    await client.rest.issues.addLabels({ ...params, labels: [disputedLabel] });
    await client.rest.issues.createComment({ ...params, body });
  });

  const extensions = await fetchExtensionIndex();
  if (!extensions) return;
  const resolution = resolveExtension(extensions, parseReport(issue.title, issue.body));
  if (resolution.kind === 'none' || resolution.kind === 'ambiguous') return;

  const pr = await findRemovalPullRequest(resolution.extension);
  if (!pr) return;

  const prToken = core.getInput('pr-token') || core.getInput('repo-token', { required: true });
  const prClient = github.getOctokit(prToken);
  await write(`Mark removal PR #${pr.number} as draft: #${issue.number} was disputed`, async () => {
    await prClient.rest.issues.createComment({
      ...params,
      issue_number: pr.number,
      body: `@${comment.user.login} says the source still works: ${comment.html_url}. Moved back to draft until a maintainer checks.`,
    });
    await prClient.graphql(
      `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }`,
      { id: pr.node_id },
    );
  });
}

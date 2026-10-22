import * as core from '@actions/core';
import * as github from '@actions/github';
import { IssueCommentEvent } from '@octokit/webhooks-types/schema';

import { GitHubClient } from '../../types';
import { write } from '../../util/dry-run';
import { fetchExtensionIndex } from '../../util/extension-index';
import { parseReport, resolveExtension } from '../../util/extension-resolver';
import { openRemovalPullRequest } from '../source-removal';

/**
 * Maintainers: open the removal PR now, regardless of age or dispute.
 * `/remove eu.kanade.tachiyomi.extension.en.example` picks the extension when the report is ambiguous.
 */
export async function removeSource(client: GitHubClient, commentBody: string) {
  if (core.getInput('removal-enabled') !== 'true') {
    core.info('SKIP: automatic source removal is disabled');
    return;
  }

  const { issue } = (github.context.payload as IssueCommentEvent);
  const params = { owner: github.context.repo.owner, repo: github.context.repo.repo, issue_number: issue.number };
  const extensions = await fetchExtensionIndex();
  if (!extensions) return;

  const explicit = commentBody.match(/eu\.kanade\.tachiyomi\.extension\.[a-z]+\.[a-z0-9]+/)?.[0];
  const resolution = explicit
    ? { kind: 'package' as const, extension: extensions.find((e) => e.packageName === explicit) }
    : resolveExtension(extensions, parseReport(issue.title, issue.body));

  if (resolution.kind === 'none' || resolution.kind === 'ambiguous' || !resolution.extension) {
    await write(`Comment on #${issue.number}: could not tell which extension to remove`, () =>
      client.rest.issues.createComment({
        ...params,
        body: 'Could not tell which extension to remove. Use `/remove <package name>`, e.g. `/remove eu.kanade.tachiyomi.extension.en.example`.',
      }),
    );
    return;
  }

  const disputed = core.getInput('disputed-label');
  if (disputed && issue.labels?.some((l) => l.name === disputed)) {
    await write(`Remove ${disputed} from #${issue.number}`, () =>
      client.rest.issues.removeLabel({ ...params, name: disputed }),
    );
  }
  await openRemovalPullRequest(resolution.extension, [issue.number]);
}

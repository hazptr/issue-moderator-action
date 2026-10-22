import * as core from '@actions/core';
import * as github from '@actions/github';

import { checkForAutoClose } from './feature/auto-closer';
import { checkForCommand } from './feature/commands';
import { checkForDuplicateUrls } from './feature/duplicate-url-check';
import { checkForExistingSource } from './feature/existing-source-check';
import { checkSourceReport } from './feature/source-report-check';
import { checkSourceRequestDomain } from './feature/source-request-dns-check';
import { checkForSourceRemovals } from './feature/source-removal';

async function withLogGroup(name: string, fn: () => Promise<void>) {
  core.startGroup(name);
  await fn();
  core.endGroup();
}

async function run() {
  try {
    const { eventName, payload } = github.context;

    if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
      await withLogGroup('Source removal', checkForSourceRemovals);
      return;
    }

    // Scheduled runs have no sender; issue events always do.
    if (!payload.sender) {
      throw new Error('Internal error, no sender provided by GitHub');
    }

    // With an app token as repo-token, the action's own comments and closes trigger new runs.
    if (payload.sender.type === 'Bot') {
      core.info(`SKIP: event sent by ${payload.sender.login}`);
      return;
    }

    if (eventName === 'issues') {
      if (!payload.action || !payload.issue) {
        core.info('Irrelevant action trigger');
        return;
      }

      await withLogGroup('Auto closer', checkForAutoClose);
      await withLogGroup('Existing source checker', checkForExistingSource);
      await withLogGroup('Duplicate URL checker', checkForDuplicateUrls);
      await withLogGroup('Source report checker', checkSourceReport);
      await withLogGroup('Source request domain checker', checkSourceRequestDomain);
      return;
    }

    if (eventName === 'issue_comment') {
      if (!payload.action || !payload.comment) {
        core.info('Irrelevant action trigger');
        return;
      }

      await withLogGroup('Command', checkForCommand);
      return;
    }
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();

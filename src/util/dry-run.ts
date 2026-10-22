import * as core from '@actions/core';

export function isDryRun(): boolean {
  return core.getInput('dry-run') === 'true';
}

/**
 * Run a write against GitHub, or only log it when `dry-run` is enabled.
 */
export async function write<T>(
  description: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (isDryRun()) {
    core.info(`[dry-run] ${description}`);
    return undefined;
  }
  core.info(description);
  return fn();
}

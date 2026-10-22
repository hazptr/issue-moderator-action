import * as core from '@actions/core';

import { GitHubClient } from '../types';

export interface IssueParameters {
  owner: string;
  repo: string;
  issue_number: number;
}

const AUTOMATED_FOOTER =
  '*This is an automated action. If you think this is a mistake, please comment about it so the issue can be reopened if needed.*';

/** Hidden marker so the action can tell which of its own comments are already on an issue. */
export function marker(name: string): string {
  return `<!-- issue-moderator:${name} -->`;
}

export async function hasMarker(
  client: GitHubClient,
  params: IssueParameters,
  name: string,
): Promise<boolean> {
  const comments = await client.paginate(client.rest.issues.listComments, {
    ...params,
    per_page: 100,
  });
  return comments.some((c) => c.body?.includes(marker(name)));
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key) => values[key] ?? all);
}

export function withFooter(body: string, markerName: string): string {
  return `${body}\n\n${AUTOMATED_FOOTER}\n${marker(markerName)}`;
}

export function jsonInput(name: string): string[] {
  const value = core.getInput(name);
  return value ? (JSON.parse(value) as string[]) : [];
}

export function labelNames(labels: (string | { name?: string })[] | undefined): string[] {
  return (labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
}

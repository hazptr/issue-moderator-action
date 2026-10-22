import * as core from '@actions/core';
import axios from 'axios';

import { IndexExtension } from './extension-resolver';

interface ExtensionRepositoryIndex {
  extensionList: {
    extensions: IndexExtension[];
  };
}

let cached: IndexExtension[] | undefined;

export async function fetchExtensionIndex(): Promise<IndexExtension[] | undefined> {
  if (cached) return cached;
  const url = core.getInput('existing-check-repo-url', { required: true });
  try {
    core.info(`Fetching ${url}`);
    const { data } = await axios.get<ExtensionRepositoryIndex>(url);
    cached = data.extensionList.extensions.map((e) => ({
      ...e,
      name: e.name.replace('Tachiyomi: ', ''),
    }));
    return cached;
  } catch (_) {
    core.error('Failed to fetch the repository JSON, aborting.');
    return undefined;
  }
}

export function knownLanguages(extensions: IndexExtension[]): string[] {
  return Array.from(new Set(extensions.flatMap((e) => e.sources.map((s) => s.language))));
}

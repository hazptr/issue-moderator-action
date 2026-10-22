import { findSection } from './urls';

export interface IndexSource {
  name: string;
  language: string;
  homeUrl: string;
  mirrorUrls?: string[];
}

export interface IndexExtension {
  name: string;
  packageName: string;
  versionName?: string;
  sources: IndexSource[];
}

export interface Report {
  name: string;
  language: string | undefined;
  hosts: string[];
  packageName: string | undefined;
}

export type Resolution =
  | {
      kind: 'package' | 'name+host' | 'name' | 'host';
      extension: IndexExtension;
    }
  | { kind: 'ambiguous'; candidates: IndexExtension[] }
  | { kind: 'none' };

const NAME_SECTIONS = ['Source name', 'Source information'];
const LINK_SECTIONS = ['Source link'];
const NO_RESPONSE = '_No response_';

const PACKAGE_REGEX = /eu\.kanade\.tachiyomi\.extension\.([a-z]+)\.([a-z0-9]+)/;
const HOST_REGEX = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,18})\b/gi;
const VERSION_REGEX = /\bv?\d+(?:\.\d+)+\b/gi;
const FILLER_WORDS = /\b(?:latest|newest|current|version|extension|ext|source|app)\b/gi;
const IGNORED_HOSTS = [
  'github.com',
  'github.blog',
  'gist.github.com',
  'user-images.githubusercontent.com',
  'keiyoushi.github.io',
  'tachiyomi.org',
  'mihon.app',
  'imgur.com',
  'i.imgur.com',
  'discord.com',
  'discord.gg',
];

/**
 * Name as typed in a report or as published, reduced to letters and digits.
 * "Yomu Mangás 1.4.3" and "yomumangas" normalize to the same string.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(VERSION_REGEX, ' ')
    .replace(/\([a-z -]+\)/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

export function cleanHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/:].*$/, '');
}

/** Second-level label, so a domain move (site.com -> site.net) still matches. */
function hostCore(host: string): string {
  const parts = host.split('.');
  if (parts.length >= 3 && ['co', 'com', 'net', 'org'].includes(parts[parts.length - 2])) {
    parts.splice(-2);
  } else {
    parts.splice(-1);
  }
  return parts[parts.length - 1] ?? host;
}

export function extensionDirectory(extension: IndexExtension): string {
  const [, lang, dir] = extension.packageName.match(PACKAGE_REGEX) ?? [];
  return `src/${lang}/${dir}`;
}

function reportedSection(body: string, sections: string[]): string {
  for (const section of sections) {
    const text = findSection(body, section);
    if (text) {
      const value = text.replace(/^#+[^\n]*\n/, '').trim();
      if (value && value !== NO_RESPONSE) return value;
    }
  }
  return '';
}

/** Body without the acknowledgements and the voting footer, which only carry template links. */
function reportText(body: string): string {
  return body.split(/^###\s+Acknowledgements|^Add a :\+1:/m)[0];
}

export function parseReport(title: string, body: string | null): Report {
  const text = reportText(body ?? '');
  const field = reportedSection(text, NAME_SECTIONS);
  // A field holding only a version ("1.6.87") says nothing; the title usually names the source.
  const name = normalizeName(field) ? field : title;
  const language = reportedSection(text, ['Source language']) || undefined;
  const link = reportedSection(text, LINK_SECTIONS);

  const hosts = new Set<string>();
  for (const match of `${text}\n${title}\n${link}`.matchAll(HOST_REGEX)) {
    const host = cleanHost(match[1]);
    if (!IGNORED_HOSTS.includes(host) && !host.endsWith('.md')) hosts.add(host);
  }

  const pkg = `${text}\n${title}`.match(PACKAGE_REGEX);
  return {
    name,
    language,
    hosts: Array.from(hosts),
    packageName: pkg?.[0],
  };
}

const LANGUAGE_ALIASES: Record<string, string> = {
  all: 'all',
  multi: 'all',
  multiple: 'all',
  multilanguage: 'all',
  brazilian: 'pt-BR',
  bahasa: 'id',
};

/** Maps "Spanish", "Español", "es" or "pt-br" to the language codes used in the index. */
export function languageCodes(reported: string | undefined, known: string[]): string[] | undefined {
  if (!reported) return undefined;
  const wanted = reported.trim().toLowerCase();
  const first = wanted.split(/[\s,/(]+/)[0];
  if (LANGUAGE_ALIASES[first]) return [LANGUAGE_ALIASES[first], 'all'];

  const matches = known.filter((code) => {
    if (code === 'all' || code === 'other') return false;
    const names = [code.toLowerCase()];
    // "pt-BR" is "Brazilian Portuguese"; also accept the base language's name.
    for (const tag of new Set([code, code.split('-')[0]])) {
      for (const locale of ['en', tag]) {
        try {
          const display = new Intl.DisplayNames([locale], { type: 'language' }).of(tag);
          if (display) names.push(display.toLowerCase());
        } catch (_) {
          // Unknown locale tag; the code itself still matches.
        }
      }
    }
    return names.some((n) => n === wanted || n === first || n.split(' ')[0] === first);
  });
  if (matches.length === 0) return undefined;

  // "Portuguese" also covers pt-BR.
  const base = new Set(matches.map((code) => code.split('-')[0]));
  return [...known.filter((code) => base.has(code.split('-')[0])), 'all'];
}

/**
 * Find the extension a report is about.
 * Only `package`, `name+host`, `name` and `host` are safe to act on.
 */
export function resolveExtension(extensions: IndexExtension[], report: Report): Resolution {
  if (report.packageName) {
    const byPackage = extensions.find((e) => e.packageName === report.packageName);
    if (byPackage) return { kind: 'package', extension: byPackage };
  }

  const knownLanguages = Array.from(
    new Set(extensions.flatMap((e) => e.sources.map((s) => s.language))),
  );
  const languages = languageCodes(report.language, knownLanguages);
  const inLanguage = (candidates: IndexExtension[]) => {
    if (!languages) return candidates;
    const filtered = candidates.filter((e) =>
      e.sources.some((s) => languages.includes(s.language)),
    );
    return filtered.length ? filtered : candidates;
  };

  const extensionHosts = (e: IndexExtension) =>
    e.sources.flatMap((s) => [s.homeUrl, ...(s.mirrorUrls ?? [])]).map(cleanHost);
  const coreCount = new Map<string, number>();
  for (const e of extensions) {
    for (const core of new Set(extensionHosts(e).map(hostCore))) {
      coreCount.set(core, (coreCount.get(core) ?? 0) + 1);
    }
  }

  const exactName = (n: string) =>
    extensions.filter(
      (e) =>
        n &&
        (normalizeName(e.name) === n || e.sources.some((s) => normalizeName(s.name) === n)),
    );
  let name = normalizeName(report.name);
  let byExactName = exactName(name);
  if (byExactName.length === 0) {
    // "Hentaifox latest", "Foo extension"
    const stripped = normalizeName(report.name.replace(FILLER_WORDS, ' '));
    if (stripped && stripped !== name) {
      byExactName = exactName(stripped);
      if (byExactName.length) name = stripped;
    }
  }
  // Sites are often reported by their domain name: "9hentai" for NineHentai at 9hentai.so.
  const byDomainName = extensions.filter(
    (e) => coreCount.get(name) === 1 && extensionHosts(e).some((h) => hostCore(h) === name),
  );
  const byName = inLanguage(byExactName.length ? byExactName : byDomainName);
  const reportedHosts = new Set(report.hosts);
  const reportedCores = new Set(
    report.hosts.map(hostCore).filter((core) => core.length >= 4 && (coreCount.get(core) ?? 0) <= 2),
  );
  // Exact hosts win; the second-level label only helps when nothing matches exactly.
  const byExactHost = extensions.filter((e) => extensionHosts(e).some((h) => reportedHosts.has(h)));
  const byHost = inLanguage(
    byExactHost.length
      ? byExactHost
      : extensions.filter((e) => extensionHosts(e).some((h) => reportedCores.has(hostCore(h)))),
  );

  if (byName.length === 1 && (byHost.length === 0 || byHost.includes(byName[0]))) {
    return { kind: byHost.length ? 'name+host' : 'name', extension: byName[0] };
  }
  const both = byName.filter((e) => byHost.includes(e));
  if (both.length === 1) return { kind: 'name+host', extension: both[0] };
  if (byHost.length === 1 && byName.length === 0) return { kind: 'host', extension: byHost[0] };

  const candidates = Array.from(new Set([...byName, ...byHost]));
  if (candidates.length) return { kind: 'ambiguous', candidates };
  return { kind: 'none' };
}

/** Directory a reported name would have had, for the previously-deleted check. */
export function guessedDirectories(report: Report, knownLanguages: string[]): string[] {
  const dir = normalizeName(report.name);
  if (!dir) return [];
  const languages = languageCodes(report.language, knownLanguages) ?? ['all'];
  return Array.from(new Set(languages)).map((lang) => `src/${lang}/${dir}`);
}

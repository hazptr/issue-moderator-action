import { describe, expect, it } from 'vitest';

import {
  IndexExtension,
  extensionDirectory,
  guessedDirectories,
  languageCodes,
  normalizeName,
  parseReport,
  resolveExtension,
} from './extension-resolver';

const extension = (name: string, pkg: string, lang: string, homeUrl: string): IndexExtension => ({
  name,
  packageName: `eu.kanade.tachiyomi.extension.${lang}.${pkg}`,
  sources: [{ name, language: lang, homeUrl }],
});

const extensions = [
  extension('Not Real Scans', 'notrealscans', 'en', 'https://notrealscans.org'),
  extension('Not Real Scans', 'notrealscansfr', 'fr', 'https://fr.notrealscans.org'),
  extension('Yomu Mangás', 'yomumangas', 'pt-BR', 'https://yomumangas.com'),
  extension('Zinmanga', 'zinmanga', 'en', 'https://zinmanga.net'),
  extension('Zinmanhwa', 'zinmanhwa', 'en', 'https://zinmanhwa.com'),
  extension('MangaDex', 'mangadex', 'all', 'https://mangadex.org'),
  extension('NineHentai', 'ninehentai', 'en', 'https://9hentai.so'),
  extension('HentaiFox', 'hentaifox', 'all', 'https://hentaifox.com'),
];

const downReport = (name: string, language: string, link: string) => `### Source name

${name}

### Source language

${language}

### Source link

${link}

### Other details

_No response_

### Acknowledgements

- [X] I have searched [existing issues](https://github.com/keiyoushi/extensions-source/issues)

---

Add a :+1: [reaction] to [issues you find important].

[reaction]: https://github.blog/2016-03-10-add-reactions-to-pull-requests-issues-and-comments/
`;

const bugReport = (information: string, language: string) => `### Source information

${information}

### Source language

${language}

### Steps to reproduce

1. Open the source
`;

describe('normalizeName', () => {
  it('drops versions, accents, case and punctuation', () => {
    expect(normalizeName('Yomu Mangás 1.4.3')).toBe('yomumangas');
    expect(normalizeName('Not-Real Scans v1.6.12')).toBe('notrealscans');
  });
});

describe('parseReport', () => {
  it('reads the dead source form and skips template links', () => {
    const report = parseReport('Not Real Scans is down', downReport('Not Real Scans', 'English', 'https://notrealscans.org'));
    expect(report.name).toBe('Not Real Scans');
    expect(report.language).toBe('English');
    expect(report.hosts).toEqual(['notrealscans.org']);
  });

  it('reads the bug form, which has no link field', () => {
    const report = parseReport('Zinmanga broken', bugReport('Zinmanga 1.4.9', 'English'));
    expect(report.name).toBe('Zinmanga 1.4.9');
    expect(report.hosts).toEqual([]);
  });

  it('finds a pasted package name', () => {
    const report = parseReport('x', bugReport('Foo (eu.kanade.tachiyomi.extension.en.zinmanga)', 'English'));
    expect(report.packageName).toBe('eu.kanade.tachiyomi.extension.en.zinmanga');
  });
});

describe('languageCodes', () => {
  const known = ['en', 'fr', 'pt-BR', 'all'];
  it.each([
    ['English', 'en'],
    ['french', 'fr'],
    ['Português', 'pt-BR'],
    ['Portuguese (Brazil)', 'pt-BR'],
  ])('maps %s', (reported, code) => {
    expect(languageCodes(reported, known)).toContain(code);
  });
  it('is undefined for unknown text', () => {
    expect(languageCodes('Klingon', known)).toBeUndefined();
  });
});

describe('resolveExtension', () => {
  const resolve = (title: string, body: string) => resolveExtension(extensions, parseReport(title, body));

  it('uses the language to pick between same-named extensions', () => {
    const r = resolve('Not Real Scans', downReport('Not Real Scans', 'French', 'https://fr.notrealscans.org'));
    expect(r.kind).toBe('name+host');
    expect('extension' in r && extensionDirectory(r.extension)).toBe('src/fr/notrealscansfr');
  });

  it('matches a bug report by name alone', () => {
    const r = resolve('Zinmanga', bugReport('Zinmanga 1.4.9', 'English'));
    expect(r.kind).toBe('name');
    expect('extension' in r && r.extension.name).toBe('Zinmanga');
  });

  it('matches a name reported as the site domain', () => {
    const r = resolve('9hentai: connection closed', bugReport('9hentai 1.6.0', 'English'));
    expect(r.kind).toBe('name');
    expect('extension' in r && r.extension.name).toBe('NineHentai');
  });

  it('ignores filler words after the name', () => {
    expect(resolve('Hfox NXDomain', bugReport('Hentaifox latest', 'English')).kind).toBe('name');
  });

  it('uses the title when the name field only holds a version', () => {
    const r = resolve('zinmanhwa', bugReport('1.6.87', 'English'));
    expect('extension' in r && r.extension.name).toBe('Zinmanhwa');
  });

  it('matches accented names', () => {
    expect(resolve('x', bugReport('YomuMangas', 'Portuguese')).kind).toBe('name');
  });

  it('matches by link when the name is wrong', () => {
    const r = resolve('site gone', downReport('Site no longer exist.', 'English', 'zinmanhwa.com'));
    expect(r.kind).toBe('host');
    expect('extension' in r && r.extension.name).toBe('Zinmanhwa');
  });

  it('matches a domain move by its second-level name', () => {
    expect(resolve('x', downReport('Zin', 'English', 'https://zinmanga.io')).kind).toBe('host');
  });

  it('reports ambiguity instead of guessing', () => {
    const r = resolve('x', downReport('Zinmanga', 'English', 'https://zinmanhwa.com'));
    expect(r.kind).toBe('ambiguous');
  });

  it('returns none for sources from other repositories', () => {
    expect(resolve('Nekohouse down', bugReport('Nekohouse', 'English')).kind).toBe('none');
  });

  it('does not match on a fuzzy name', () => {
    expect(resolve('MangaDE', bugReport('MangaDE', 'English')).kind).toBe('none');
  });
});

describe('guessedDirectories', () => {
  it('guesses the directory from the name and language', () => {
    const report = parseReport('x', bugReport('Old Scans 1.4.2', 'English'));
    expect(guessedDirectories(report, ['en', 'all'])).toEqual(['src/en/oldscans', 'src/all/oldscans']);
  });
});

import { describe, expect, it } from 'vitest';

import { domainIsGone, registrableDomain } from '../util/domain-evidence';
import { isDue, removalBranch } from './source-removal';

describe('isDue', () => {
  const labeled = new Date('2026-10-01T12:00:00Z');
  it('waits the full number of days', () => {
    expect(isDue(labeled, new Date('2026-10-15T11:59:00Z'), 14)).toBe(false);
    expect(isDue(labeled, new Date('2026-10-15T12:00:00Z'), 14)).toBe(true);
  });
});

describe('removalBranch', () => {
  it('names the branch after the extension directory', () => {
    expect(
      removalBranch({
        name: 'Not Real Scans',
        packageName: 'eu.kanade.tachiyomi.extension.en.notrealscans',
        sources: [],
      }),
    ).toBe('bot/remove/en-notrealscans');
  });
});

describe('registrableDomain', () => {
  it.each([
    ['fr.notrealscans.org', 'notrealscans.org'],
    ['notrealscans.com.br', 'notrealscans.com.br'],
    ['notrealscans.co.uk', 'notrealscans.co.uk'],
  ])('%s -> %s', (host, domain) => {
    expect(registrableDomain(host)).toBe(domain);
  });
});

describe('domainIsGone', () => {
  const base = { host: 'a.org', nameservers: [], parked: false, rdapStatus: [], registered: true };
  it('treats NXDOMAIN, parking, unregistered and expired as gone', () => {
    expect(domainIsGone({ ...base, dns: 'nxdomain' })).toBe(true);
    expect(domainIsGone({ ...base, dns: 'resolves', parked: true })).toBe(true);
    expect(domainIsGone({ ...base, dns: 'resolves', registered: false })).toBe(true);
    expect(domainIsGone({ ...base, dns: 'resolves', expires: '2020-01-01T00:00:00Z' })).toBe(true);
  });
  it('does not treat a resolving, registered domain as gone', () => {
    expect(domainIsGone({ ...base, dns: 'resolves', expires: '2099-01-01T00:00:00Z' })).toBe(false);
  });
});

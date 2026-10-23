import { describe, expect, it } from 'vitest';

import { domainIsGone, registrableDomain } from '../util/domain-evidence';
import { inRecheckBucket } from './source-request-dns-check';
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
  it('treats NXDOMAIN as gone', () => {
    expect(domainIsGone({ ...base, dns: 'nxdomain' })).toBe(true);
  });
  it('never decides on nameservers', () => {
    // Hostinger's default nameservers (dns-parking.com) also serve live sites.
    expect(domainIsGone({ ...base, dns: 'resolves', parked: true })).toBe(false);
  });
  it('uses RDAP only when DNS has no answer', () => {
    expect(domainIsGone({ ...base, dns: 'no-answer', registered: false })).toBe(true);
    expect(domainIsGone({ ...base, dns: 'no-answer', expires: '2020-01-01T00:00:00Z' })).toBe(true);
    // rdap.org 404s for TLDs without RDAP, e.g. .jp and .eu
    expect(domainIsGone({ ...base, dns: 'resolves', registered: false })).toBe(false);
    expect(domainIsGone({ ...base, dns: 'unknown', registered: false })).toBe(false);
  });
  it('does not treat a resolving, registered domain as gone', () => {
    expect(domainIsGone({ ...base, dns: 'resolves', expires: '2099-01-01T00:00:00Z' })).toBe(false);
  });
});

describe('inRecheckBucket', () => {
  it('checks every request once per period', () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 9, 20 + i)));
    for (const n of [1, 2, 3, 19763, 14819]) {
      expect(days.filter((d) => inRecheckBucket(n, d, 7))).toHaveLength(1);
    }
  });
  it('checks everything when the period is one day', () => {
    expect(inRecheckBucket(5, new Date(), 1)).toBe(true);
  });
});

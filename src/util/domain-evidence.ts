import axios from 'axios';

/**
 * What public DNS and RDAP say about a site's domain. Nothing here contacts the site itself.
 */
export interface DomainEvidence {
  host: string;
  dns: 'resolves' | 'nxdomain' | 'no-answer' | 'unknown';
  nameservers: string[];
  parked: boolean;
  expires?: string;
  rdapStatus: string[];
  registered: boolean | undefined;
}

// Nameservers that serve parking or for-sale pages instead of a site.
const PARKING_NAMESERVERS = [
  'dns-parking.com',
  'parkingcrew.net',
  'sedoparking.com',
  'bodis.com',
  'above.com',
  'parklogic.com',
  'dan.com',
  'afternic.com',
  'parked.com',
  'expired.domains',
  'dns-expired.com',
  'parity.domains',
];

const DOH = 'https://cloudflare-dns.com/dns-query';
const TIMEOUT = 10_000;

export function registrableDomain(host: string): string {
  const parts = host.split('.');
  const secondLevel = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'];
  if (parts.length >= 3 && secondLevel.includes(parts[parts.length - 2])) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

async function dnsQuery(name: string, type: string) {
  const { data } = await axios.get(DOH, {
    params: { name, type },
    headers: { accept: 'application/dns-json' },
    timeout: TIMEOUT,
  });
  return data as { Status: number; Answer?: { type: number; data: string }[] };
}

export async function domainEvidence(host: string): Promise<DomainEvidence> {
  const domain = registrableDomain(host);
  const evidence: DomainEvidence = {
    host,
    dns: 'unknown',
    nameservers: [],
    parked: false,
    rdapStatus: [],
    registered: undefined,
  };

  try {
    const a = await dnsQuery(host, 'A');
    if (a.Status === 3) evidence.dns = 'nxdomain';
    else if (a.Answer?.some((r) => r.type === 1)) evidence.dns = 'resolves';
    else evidence.dns = 'no-answer';
  } catch (_) {
    // Leave as unknown.
  }

  try {
    const ns = await dnsQuery(domain, 'NS');
    evidence.nameservers = (ns.Answer ?? [])
      .filter((r) => r.type === 2)
      .map((r) => r.data.replace(/\.$/, '').toLowerCase());
    evidence.parked = evidence.nameservers.some((n) =>
      PARKING_NAMESERVERS.some((p) => n === p || n.endsWith(`.${p}`)),
    );
  } catch (_) {
    // Leave empty.
  }

  try {
    const { data, status } = await axios.get(`https://rdap.org/domain/${domain}`, {
      timeout: TIMEOUT,
      validateStatus: (s) => s === 200 || s === 404,
    });
    evidence.registered = status === 200;
    if (status === 200) {
      evidence.rdapStatus = data.status ?? [];
      evidence.expires = (data.events ?? []).find(
        (e: { eventAction: string }) => e.eventAction === 'expiration',
      )?.eventDate;
    }
  } catch (_) {
    // Many ccTLDs have no RDAP service.
  }

  return evidence;
}

/** True when the domain itself is gone, not just the site behind it. */
export function domainIsGone(e: DomainEvidence): boolean {
  const expired = e.expires !== undefined && new Date(e.expires).getTime() < Date.now();
  return e.dns === 'nxdomain' || e.parked || e.registered === false || expired;
}

export function formatEvidence(e: DomainEvidence): string {
  const lines = [
    `- DNS for \`${e.host}\`: ${e.dns}`,
    `- Nameservers: ${e.nameservers.length ? e.nameservers.map((n) => `\`${n}\``).join(', ') : 'none'}${e.parked ? ' (parking service)' : ''}`,
  ];
  if (e.registered === false) lines.push('- RDAP: domain not registered');
  else if (e.registered) {
    lines.push(
      `- RDAP: ${e.rdapStatus.join(', ') || 'no status'}${e.expires ? `, expires ${e.expires.slice(0, 10)}` : ''}`,
    );
  } else lines.push('- RDAP: not available for this TLD');
  return lines.join('\n');
}

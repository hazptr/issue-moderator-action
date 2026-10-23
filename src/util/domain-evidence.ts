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

// Nameservers of services that only serve parking or for-sale pages. Shown as information only:
// registrar defaults such as Hostinger's dns-parking.com also host live sites, so nameservers never decide.
const PARKING_NAMESERVERS = ['parity.domains', 'park-my-domain.net', 'sedoparking.com', 'parkingcrew.net', 'bodis.com'];

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

/**
 * True when the domain itself no longer exists: DNS says NXDOMAIN, or DNS has no answer and RDAP
 * confirms it is unregistered or expired. RDAP alone never decides (rdap.org answers 404 for every
 * TLD it has no RDAP service for), and neither do nameservers.
 */
export function domainIsGone(e: DomainEvidence): boolean {
  if (e.dns === 'nxdomain') return true;
  if (e.dns !== 'no-answer') return false;
  const expired = e.expires !== undefined && new Date(e.expires).getTime() < Date.now();
  return e.registered === false || expired;
}

export function formatEvidence(e: DomainEvidence): string {
  const lines = [
    `- DNS for \`${e.host}\`: ${e.dns}`,
    `- Nameservers: ${e.nameservers.length ? e.nameservers.map((n) => `\`${n}\``).join(', ') : 'none'}${e.parked ? ' (a parking service)' : ''}`,
  ];
  if (e.registered === false) lines.push('- RDAP: no record found');
  else if (e.registered) {
    lines.push(
      `- RDAP: ${e.rdapStatus.join(', ') || 'no status'}${e.expires ? `, expires ${e.expires.slice(0, 10)}` : ''}`,
    );
  } else lines.push('- RDAP: not available for this TLD');
  return lines.join('\n');
}

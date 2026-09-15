// Which IP addresses a tool-driven fetch may never reach.
//
// The attack this file exists for is server-side request forgery: a document
// says "read https://status.example/health", the hostname resolves to
// 169.254.169.254, and the Worker fetches a cloud metadata endpoint on behalf
// of whoever wrote the document. Everything private, loopback, link-local,
// carrier-grade-NAT, multicast or reserved is refused, in both address
// families, and the refusal names the range so the log line is readable.
//
// The ranges are written out rather than pulled from a library because the list
// is the security property: a dependency that quietly drops 100.64.0.0/10 in a
// minor release would be a silent hole, and this is thirty lines.

export interface IpVerdict {
  readonly allowed: boolean;
  /** The range that refused it, for the error and the trace. */
  readonly range?: string;
}

const ALLOWED: IpVerdict = { allowed: true };
const refuse = (range: string): IpVerdict => ({ allowed: false, range });

/** Parse dotted-quad IPv4 into four octets, or null if it is not one. */
export function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function checkIpv4(octets: [number, number, number, number]): IpVerdict {
  const [a, b] = octets;
  if (a === 0) return refuse('0.0.0.0/8');
  if (a === 10) return refuse('10.0.0.0/8');
  if (a === 127) return refuse('127.0.0.0/8');
  if (a === 100 && b >= 64 && b <= 127) return refuse('100.64.0.0/10');
  if (a === 169 && b === 254) return refuse('169.254.0.0/16');
  if (a === 172 && b >= 16 && b <= 31) return refuse('172.16.0.0/12');
  if (a === 192 && b === 0) return refuse('192.0.0.0/24');
  if (a === 192 && b === 168) return refuse('192.168.0.0/16');
  if (a === 198 && (b === 18 || b === 19)) return refuse('198.18.0.0/15');
  if (a >= 224) return refuse('224.0.0.0/4 and above');
  return ALLOWED;
}

/** Expand an IPv6 literal (with or without `::`) into its eight groups. */
export function parseIpv6(value: string): number[] | null {
  const raw = value.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (!raw.includes(':')) return null;
  const [head, tail, ...rest] = raw.split('::');
  if (rest.length > 0) return null;
  const group = (part: string): number[] =>
    part.length === 0 ? [] : part.split(':').map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  // A trailing IPv4 form (::ffff:127.0.0.1) is handled by the caller, which
  // checks the embedded address in its own family.
  const left = group(head ?? '');
  const right = tail === undefined ? [] : group(tail);
  if ([...left, ...right].some(Number.isNaN)) return null;
  if (tail === undefined) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array.from({ length: fill }, () => 0), ...right];
}

function checkIpv6(groups: number[]): IpVerdict {
  const first = groups[0] ?? 0;
  if (groups.every((g) => g === 0)) return refuse('::');
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return refuse('::1');
  if ((first & 0xfe00) === 0xfc00) return refuse('fc00::/7');
  if ((first & 0xffc0) === 0xfe80) return refuse('fe80::/10');
  if ((first & 0xff00) === 0xff00) return refuse('ff00::/8');
  return ALLOWED;
}

/**
 * Is this address one a tool may fetch?
 *
 * `::ffff:a.b.c.d` is checked as IPv4, because that is what it is: an
 * IPv4-mapped address reaching 127.0.0.1 through an IPv6 literal is the oldest
 * way around a naive loopback check.
 */
export function checkAddress(value: string): IpVerdict {
  const address = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) {
    const octets = parseIpv4(mapped[1]);
    return octets ? checkIpv4(octets) : refuse('unparseable');
  }
  const v4 = parseIpv4(address);
  if (v4) return checkIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6) return checkIpv6(v6);
  return refuse('unparseable');
}

/** True when a hostname is itself an IP literal, which skips DNS entirely. */
export function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return parseIpv4(bare) !== null || parseIpv6(bare) !== null;
}

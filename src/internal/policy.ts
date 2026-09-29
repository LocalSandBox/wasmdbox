import net from 'node:net';
import { domainToASCII } from 'node:url';

export interface PolicyOptions {
  allow?: readonly string[];
  deny?: readonly string[];
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

type Matcher = (host: string) => boolean;

export function createPolicy({ allow, deny = [] }: PolicyOptions = {}) {
  const allowed = allow?.map(compile);
  const denied = deny.map(compile);
  const active = allowed !== undefined || denied.length > 0;
  const matches = (rules: readonly Matcher[] | undefined, host: string) => rules?.some(rule => rule(host)) ?? false;
  const checkHost = (host: string) => {
    if (matches(denied, host)) throw deniedError();
    if (net.isIP(host) && active && !matches(allowed, host)) throw deniedError();
  };
  return {
    checkHost,
    select(host: string, addresses: readonly { address: string }[]): ResolvedAddress[] {
      checkHost(host);
      const candidates = addresses.map(({ address }): ResolvedAddress => {
        if (!net.isIP(address)) throw new TypeError('Resolver must return IP addresses');
        address = normalizeHost(address);
        return { address, family: net.isIP(address) as 4 | 6 };
      }).filter(({ address }) => !matches(denied, address)
        && (allowed === undefined || matches(allowed, host) || matches(allowed, address)));
      if (!candidates.length) throw deniedError();
      return candidates;
    },
  };
}

export function normalizeHost(input: string): string {
  if (typeof input !== 'string') throw new TypeError('Invalid hostname');
  if (net.isIP(input) === 6) return new URL(`http://[${input}]/`).hostname.slice(1, -1);
  if (net.isIP(input)) return input;
  const host = domainToASCII(input.replace(/\.$/, '').toLowerCase());
  if (!host || host.length > 253 || !host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new TypeError('Invalid hostname');
  return host;
}

/** Secret scopes intentionally accept domains, never literal IPs or CIDRs. */
export function compileDomainPattern(pattern: string): Matcher {
  if (typeof pattern !== 'string') throw new TypeError('Domain rules must be strings');
  if (pattern === '*') return host => net.isIP(host) === 0;
  const wildcard = pattern.startsWith('*.');
  const domain = normalizeHost(wildcard ? pattern.slice(2) : pattern);
  if (net.isIP(domain)) throw new TypeError('Secret hosts must be domains');
  return host => !net.isIP(host) && (wildcard ? host.endsWith(`.${domain}`) : host === domain);
}

function compile(pattern: string): Matcher {
  if (typeof pattern !== 'string') throw new TypeError('Policy entries must be strings');
  if (pattern === '*') return () => true;
  const [address, prefix, extra] = pattern.split('/');
  const family = net.isIP(address);
  if (!family) {
    if (prefix !== undefined) throw new TypeError('Invalid CIDR');
    return compileDomainPattern(pattern);
  }
  const bits = family === 4 ? 32 : 128;
  const length = prefix === undefined ? bits : Number(prefix);
  if (extra !== undefined || (prefix !== undefined && !/^\d+$/.test(prefix))
      || !Number.isInteger(length) || length < 0 || length > bits) throw new TypeError('Invalid CIDR');
  const list = new net.BlockList();
  list.addSubnet(address, length, family === 4 ? 'ipv4' : 'ipv6');
  return host => net.isIP(host) !== 0 && list.check(host, net.isIP(host) === 4 ? 'ipv4' : 'ipv6');
}

function deniedError(): Error {
  return Object.assign(new Error('Proxy policy denied target'), { code: 'EPERM' });
}

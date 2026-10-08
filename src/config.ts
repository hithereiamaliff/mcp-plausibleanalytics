/**
 * Connection configuration for a single Plausible account.
 *
 * Credentials arrive from three places (key-service, self-hosted headers, CLI env)
 * as loosely-typed strings. normalizeConnection() turns them into one validated
 * shape so the rest of the server never deals with raw input.
 */

import dns from 'dns';
import net, { type LookupFunction } from 'net';

export const DEFAULT_PLAUSIBLE_URL = 'https://plausible.io';

export interface ConnectionInput {
  url?: string | null;
  apiKey?: string | null;
  sites?: string | null;
  pluginTokens?: string | null;
  allowWrites?: string | boolean | null;
}

export interface PlausibleConnection {
  /** Instance base URL without trailing slash, e.g. https://plausible.example.com */
  baseUrl: string;
  /** Stats API key (Bearer token) */
  apiKey: string;
  /** Configured site domains; the first one is the default site */
  sites: string[];
  defaultSite?: string;
  /** Plugins API tokens keyed by site domain (self-hosted management tools) */
  pluginTokens: Record<string, string>;
  /** Whether tools that change data are registered */
  allowWrites: boolean;
  /** Plausible Cloud (plausible.io) rather than a self-hosted instance */
  isCloud: boolean;
  /** Non-fatal configuration problems, surfaced by hello / get_instance_info */
  warnings: string[];
}

export class ConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionConfigError';
  }
}

// =============================================================================
// Parsing helpers
// =============================================================================

const API_PATH_SUFFIX = /\/api(\/v[12](\/query)?)?$/i;

export function normalizeBaseUrl(raw?: string | null): string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_PLAUSIBLE_URL;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConnectionConfigError(`Invalid Plausible URL "${value}".`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConnectionConfigError(`Plausible URL must use http or https (got "${url.protocol}").`);
  }
  if (url.username || url.password) {
    throw new ConnectionConfigError('Plausible URL must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new ConnectionConfigError('Plausible URL must not contain a query string or fragment.');
  }

  // Accept pasted API URLs such as https://host/api/v2/query
  const path = url.pathname.replace(/\/+$/, '').replace(API_PATH_SUFFIX, '');
  return `${url.protocol}//${url.host}${path}`;
}

export function normalizeSiteDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function parseSites(raw?: string | null): string[] {
  if (!raw) return [];
  const sites = raw
    .split(/[\s,;]+/)
    .map(normalizeSiteDomain)
    .filter(Boolean);
  return [...new Set(sites)];
}

export function parseBoolean(raw?: string | boolean | null): boolean {
  if (typeof raw === 'boolean') return raw;
  if (!raw) return false;
  return ['yes', 'y', 'true', '1', 'on', 'enable', 'enabled'].includes(raw.trim().toLowerCase());
}

/**
 * Parse "example.com=TOKEN, blog.example.com=TOKEN".
 * A single bare token (no "=") is assigned to the default site.
 */
export function parsePluginTokens(
  raw: string | null | undefined,
  defaultSite: string | undefined,
): { tokens: Record<string, string>; warnings: string[] } {
  const tokens: Record<string, string> = {};
  const warnings: string[] = [];
  if (!raw || !raw.trim()) return { tokens, warnings };

  const entries = raw.split(/[\s,;]+/).filter(Boolean);
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator === -1) {
      if (entries.length === 1 && defaultSite) {
        tokens[defaultSite] = entry;
      } else {
        warnings.push('Ignored a plugin token without a site domain. Use the format "example.com=TOKEN".');
      }
      continue;
    }

    const site = normalizeSiteDomain(entry.slice(0, separator));
    const token = entry.slice(separator + 1).trim();
    if (!site || !token) {
      warnings.push('Ignored a malformed plugin token entry. Use the format "example.com=TOKEN".');
      continue;
    }
    tokens[site] = token;
  }

  return { tokens, warnings };
}

export function isCloudUrl(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname === 'plausible.io' || hostname === 'www.plausible.io';
}

export function normalizeConnection(input: ConnectionInput): PlausibleConnection {
  const apiKey = (input.apiKey ?? '').trim();
  if (!apiKey) {
    throw new ConnectionConfigError('Missing Plausible API key.');
  }

  const baseUrl = normalizeBaseUrl(input.url);
  const sites = parseSites(input.sites);
  const defaultSite = sites[0];
  const { tokens, warnings } = parsePluginTokens(input.pluginTokens, defaultSite);

  for (const site of Object.keys(tokens)) {
    if (!sites.includes(site)) sites.push(site);
  }

  return {
    baseUrl,
    apiKey,
    sites,
    defaultSite: sites[0],
    pluginTokens: tokens,
    allowWrites: parseBoolean(input.allowWrites),
    isCloud: isCloudUrl(baseUrl),
    warnings,
  };
}

// =============================================================================
// SSRF guard — user-supplied instance URLs must not reach internal services
// =============================================================================

// Separate lists: Node's BlockList maps IPv4 into ::ffff:0:0/96, so mixing families
// in one list makes IPv6 rules match IPv4 addresses.
const privateIpv4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  privateIpv4.addSubnet(address, prefix, 'ipv4');
}

const privateIpv6 = new net.BlockList();
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  privateIpv6.addSubnet(address, prefix, 'ipv6');
}

/** IPv4-mapped IPv6 (::ffff:10.0.0.1 or ::ffff:a00:1) → embedded IPv4 */
function embeddedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return undefined;
}

export function isPrivateAddress(address: string): boolean {
  const mapped = embeddedIpv4(address);
  if (mapped) return privateIpv4.check(mapped, 'ipv4');

  const family = net.isIP(address);
  if (family === 4) return privateIpv4.check(address, 'ipv4');
  if (family === 6) return privateIpv6.check(address, 'ipv6');
  return true;
}

/**
 * net/tls `lookup` hook that refuses private addresses at connect time, so the address
 * that was checked is the address actually connected to (no DNS-rebinding window).
 * Node does not call `lookup` for IP literals — assertPublicPlausibleHost covers those.
 */
export function createGuardedLookup(allowedHosts: string[] = []): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 4);
        return;
      }
      if (!allowedHosts.includes(hostname.toLowerCase()) && addresses.some(({ address }) => isPrivateAddress(address))) {
        const blocked = Object.assign(
          new Error(`Plausible host "${hostname}" resolves to a private or internal address, which is not allowed on this server.`),
          { code: 'EPRIVATEADDRESS' },
        );
        callback(blocked, '', 4);
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };
}

/** Drop expired entries once a cache grows past maxSize */
export function pruneExpired<V extends { expiresAt: number }>(map: Map<string, V>, maxSize: number): void {
  if (map.size < maxSize) return;
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now >= entry.expiresAt) map.delete(key);
  }
}

/**
 * Reject instance URLs whose host is a private / loopback / link-local IP literal, unless
 * allow-listed by the operator. Node never calls `lookup` for IP literals, so this covers
 * what the connect-time guard (createGuardedLookup) cannot; hostnames are checked there,
 * on the address actually connected to.
 */
export async function assertPublicPlausibleHost(baseUrl: string, allowedHosts: string[] = []): Promise<void> {
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (allowedHosts.includes(hostname) || !net.isIP(hostname)) return;

  if (isPrivateAddress(hostname)) {
    throw new ConnectionConfigError(
      `Plausible host "${hostname}" is a private or internal address, which is not allowed on this server.`,
    );
  }
}

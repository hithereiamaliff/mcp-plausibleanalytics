/**
 * Instance profile: what the connected Plausible instance is and what it supports.
 *
 * Uses public, unauthenticated endpoints only:
 *   GET /api/system                    → build version + geo database (CE ≥ 3.0)
 *   GET /api/docs/query/schema.json    → the exact Stats API v2 schema the instance accepts
 *
 * Cached per base URL for 10 minutes. Probe failures never block tool registration;
 * they are reported by get_instance_info and used to enrich error hints.
 */

import { isCloudUrl, pruneExpired } from '../config.js';
import { PlausibleClient } from './client.js';

export type Version = [number, number, number];

export interface InstanceProfile {
  baseUrl: string;
  edition: 'cloud' | 'community';
  /** Version string as reported by the instance, e.g. "v3.2.1" (null on Cloud) */
  version?: string;
  versionNumber?: Version;
  geoDatabase?: string;
  schema?: {
    metrics: string[];
    dateRangeShorthands: string[];
    supportsRelativeRanges: boolean;
    includeKeys: string[];
  };
  errors: string[];
  fetchedAt: string;
}

const PROFILE_TTL_MS = 10 * 60_000;
const PROFILE_FAILURE_TTL_MS = 60_000;

const cache = new Map<string, { profile: InstanceProfile; expiresAt: number }>();
const pending = new Map<string, Promise<InstanceProfile>>();

export function parseVersion(raw?: string | null): Version | undefined {
  if (!raw) return undefined;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** true / false when the version is known, undefined when it isn't */
export function versionAtLeast(profile: InstanceProfile | undefined, minimum: Version): boolean | undefined {
  const version = profile?.versionNumber;
  if (!version) return undefined;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

export function describeInstance(profile: InstanceProfile | undefined): string {
  if (!profile) return 'unknown Plausible instance';
  if (profile.edition === 'cloud') return 'Plausible Cloud';
  return `Plausible Community Edition ${profile.version ?? '(version unknown)'}`;
}

function constsOf(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const options = (record.oneOf ?? record.anyOf) as unknown[] | undefined;
  if (Array.isArray(options)) {
    return options
      .map(option => (option as Record<string, unknown>)?.const)
      .filter((value): value is string => typeof value === 'string');
  }
  if (Array.isArray(record.enum)) return record.enum.filter((value): value is string => typeof value === 'string');
  return [];
}

export function summarizeSchema(schema: Record<string, unknown>): InstanceProfile['schema'] {
  const definitions = (schema.definitions ?? schema.$defs ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const shorthand = definitions.date_range_shorthand as Record<string, unknown> | undefined;
  const shorthandOptions = ((shorthand?.anyOf ?? shorthand?.oneOf) as Array<Record<string, unknown>> | undefined) ?? [];

  return {
    metrics: constsOf(definitions.metric),
    dateRangeShorthands: constsOf(shorthand),
    supportsRelativeRanges: shorthandOptions.some(option => typeof option.pattern === 'string'),
    includeKeys: Object.keys((properties.include?.properties ?? {}) as Record<string, unknown>),
  };
}

async function buildProfile(client: PlausibleClient): Promise<InstanceProfile> {
  const profile: InstanceProfile = {
    baseUrl: client.baseUrl,
    edition: isCloudUrl(client.baseUrl) ? 'cloud' : 'community',
    errors: [],
    fetchedAt: new Date().toISOString(),
  };

  const [system, schema] = await Promise.allSettled([client.systemInfo(), client.querySchema()]);

  if (system.status === 'fulfilled') {
    const version = system.value.build?.version ?? undefined;
    profile.version = version || undefined;
    profile.versionNumber = parseVersion(version);
    profile.geoDatabase = system.value.geo_database;
  } else {
    profile.errors.push(`Version check (/api/system) failed: ${system.reason instanceof Error ? system.reason.message : String(system.reason)}`);
  }

  if (schema.status === 'fulfilled' && schema.value && typeof schema.value === 'object') {
    profile.schema = summarizeSchema(schema.value);
  } else if (schema.status === 'rejected') {
    profile.errors.push(`Schema check (/api/docs/query/schema.json) failed: ${schema.reason instanceof Error ? schema.reason.message : String(schema.reason)}`);
  }

  return profile;
}

export async function getInstanceProfile(
  client: PlausibleClient,
  options: { fresh?: boolean } = {},
): Promise<InstanceProfile> {
  const key = client.baseUrl;

  if (!options.fresh) {
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.profile;
  }

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const promise = buildProfile(client)
    .then(profile => {
      const ttl = profile.errors.length > 0 ? PROFILE_FAILURE_TTL_MS : PROFILE_TTL_MS;
      pruneExpired(cache, 200);
      cache.set(key, { profile, expiresAt: Date.now() + ttl });
      return profile;
    })
    .finally(() => pending.delete(key));

  pending.set(key, promise);
  return promise;
}

/** Profile if already cached (no network) — used to enrich error hints cheaply */
export function getCachedProfile(baseUrl: string): InstanceProfile | undefined {
  const cached = cache.get(baseUrl);
  return cached && Date.now() < cached.expiresAt ? cached.profile : undefined;
}

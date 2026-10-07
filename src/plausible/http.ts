/**
 * Low-level HTTP helper shared by every Plausible API client.
 *
 * - per-request timeout (AbortSignal)
 * - no automatic redirects (instance URLs are user-supplied; never follow them to another host)
 * - limited retry on 429
 * - uniform PlausibleApiError with the API's own error message
 */

import { Agent, type Dispatcher, fetch } from 'undici';
import { createGuardedLookup } from '../config.js';
import { REPOSITORY_URL, SERVER_VERSION } from '../version.js';

let guardedDispatcher: Dispatcher | undefined;

/**
 * HTTP server mode: validate every connection's resolved address (SSRF / DNS rebinding).
 * CLI mode leaves this off so local and private instances keep working.
 */
export function configurePrivateAddressGuard(enabled: boolean, allowedHosts: string[] = []): void {
  guardedDispatcher = enabled ? new Agent({ connect: { lookup: createGuardedLookup(allowedHosts) } }) : undefined;
}

export const DEFAULT_TIMEOUT_MS = parseInt(process.env.PLAUSIBLE_TIMEOUT_MS || '30000', 10);
const MAX_429_RETRIES = 2;
const USER_AGENT = `mcp-plausibleanalytics/${SERVER_VERSION} (+${REPOSITORY_URL})`;

export type PlausibleAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username?: string; password: string }
  | { type: 'none' };

export interface PlausibleRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth: PlausibleAuth;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface PlausibleResponse<T> {
  status: number;
  data: T;
  headers: { get(name: string): string | null };
}

export class PlausibleApiError extends Error {
  constructor(
    /** HTTP status, or 0 for network errors / timeouts */
    public readonly status: number,
    message: string,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'PlausibleApiError';
  }
}

function buildUrl(baseUrl: string, path: string, query?: PlausibleRequestOptions['query']): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function authHeader(auth: PlausibleAuth): string | undefined {
  if (auth.type === 'bearer') return `Bearer ${auth.token}`;
  if (auth.type === 'basic') {
    const credentials = Buffer.from(`${auth.username ?? ''}:${auth.password}`).toString('base64');
    return `Basic ${credentials}`;
  }
  return undefined;
}

/**
 * Pull a readable message out of the various Plausible error shapes:
 *   Stats/Sites API: {"error": "..."}
 *   Plugins API:     {"errors": [{"detail": "..."}]}
 *   Events API:      {"errors": {"field": ["..."]}}
 */
export function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;

  if (typeof record.error === 'string') return record.error;
  if (typeof record.message === 'string') return record.message;

  if (Array.isArray(record.errors)) {
    const details = record.errors
      .map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>).detail : item))
      .filter((detail): detail is string => typeof detail === 'string');
    if (details.length > 0) return details.join('; ');
  }

  if (record.errors && typeof record.errors === 'object') {
    return Object.entries(record.errors as Record<string, unknown>)
      .map(([field, value]) => `${field}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
      .join('; ');
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(response: { headers: { get(name: string): string | null } }, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 10) return retryAfter * 1000;
  return 1000 * 2 ** attempt;
}

export async function plausibleRequest<T = unknown>(
  baseUrl: string,
  path: string,
  options: PlausibleRequestOptions,
): Promise<PlausibleResponse<T>> {
  const method = options.method ?? 'GET';
  const url = buildUrl(baseUrl, path, options.query);
  const endpoint = `${method} ${path}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...options.headers,
  };
  const authorization = authHeader(options.auth);
  if (authorization) headers.Authorization = authorization;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: guardedDispatcher,
      });
    } catch (error) {
      const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const reason = isTimeout
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : `failed (${error instanceof Error ? (error.cause as Error | undefined)?.message || error.message : String(error)})`;
      throw new PlausibleApiError(0, `Request to Plausible ${reason}.`, endpoint);
    }

    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      // Release the connection before retrying
      await response.body?.cancel().catch(() => {});
      await sleep(retryDelayMs(response, attempt));
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location') || 'another URL';
      throw new PlausibleApiError(
        response.status,
        `Plausible redirected the request to ${location}. Set the instance URL to the final address (e.g. the https:// URL, without a path).`,
        endpoint,
      );
    }

    const text = await response.text();
    let data: unknown = text;
    const isJson = (response.headers.get('content-type') || '').includes('json');
    if (text && isJson) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else if (!text) {
      data = null;
    }

    if (!response.ok) {
      const message = extractErrorMessage(data)
        || (typeof data === 'string' && data && !/^\s*</.test(data) ? data.slice(0, 300) : response.statusText)
        || `HTTP ${response.status}`;
      throw new PlausibleApiError(response.status, message, endpoint);
    }

    return { status: response.status, data: data as T, headers: response.headers };
  }
}

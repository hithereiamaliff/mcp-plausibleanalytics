/**
 * Shared plumbing for tool modules: per-connection context, site resolution,
 * uniform error handling and common zod parameter schemas.
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ConnectionConfigError, normalizeSiteDomain, type PlausibleConnection, pruneExpired } from '../config.js';
import { PlausibleClient } from '../plausible/client.js';
import { hintForError } from '../plausible/format.js';
import { PlausibleApiError } from '../plausible/http.js';
import { PluginsClient } from '../plausible/plugins-client.js';
import { getCachedProfile } from '../plausible/profile.js';
import {
  DATE_RANGE_DESCRIPTION,
  DIMENSION_DESCRIPTION,
  FILTER_OPERATORS,
  METRICS,
  METRICS_DESCRIPTION,
  ToolInputError,
} from '../plausible/query-helpers.js';
import { SitesClient } from '../plausible/sites-client.js';
import { shortHash } from '../utils/mask.js';

export interface ToolContext {
  connection: PlausibleConnection;
  stats: PlausibleClient;
  /** Sites API client — only on Plausible Cloud */
  sites?: SitesClient;
  transport: 'stdio' | 'streamable-http';
  authMode: string;
}

export function createToolContext(
  connection: PlausibleConnection,
  options: { transport: ToolContext['transport']; authMode: string },
): ToolContext {
  return {
    connection,
    stats: new PlausibleClient(connection.baseUrl, connection.apiKey),
    sites: connection.isCloud ? new SitesClient(connection.baseUrl, connection.apiKey) : undefined,
    ...options,
  };
}

export function pluginsClientFor(ctx: ToolContext, site: string): PluginsClient | undefined {
  const tokens = ctx.connection.pluginTokens;
  const token = Object.hasOwn(tokens, site) ? tokens[site] : undefined;
  return token ? new PluginsClient(ctx.connection.baseUrl, site, token) : undefined;
}

const PLUGIN_TOKEN_TTL_MS = 10 * 60_000;
const pluginTokenSites = new Map<string, { domain: string | null; expiresAt: number }>();

/** Site a plugin token actually belongs to (null = rejected), cached per token */
export async function pluginTokenSite(ctx: ToolContext, site: string, client: PluginsClient): Promise<string | null> {
  const key = `${ctx.connection.baseUrl}|${site}|${shortHash(ctx.connection.pluginTokens[site])}`;
  const cached = pluginTokenSites.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.domain;

  const { authorized, data_domain } = await client.capabilities();
  const domain = authorized && data_domain ? normalizeSiteDomain(data_domain) : null;
  pruneExpired(pluginTokenSites, 500);
  pluginTokenSites.set(key, { domain, expiresAt: Date.now() + PLUGIN_TOKEN_TTL_MS });
  return domain;
}

/**
 * Plugins API client verified to belong to `site`. The Plugins API ignores the Basic-auth
 * username and always acts on the token's own site, so a mis-mapped token must not be used.
 */
export async function verifiedPluginsClient(ctx: ToolContext, site: string): Promise<PluginsClient | undefined> {
  const client = pluginsClientFor(ctx, site);
  if (!client) return undefined;

  const domain = await pluginTokenSite(ctx, site, client);
  if (domain !== site) {
    throw new ToolInputError(
      domain
        ? `The plugin token configured for ${site} belongs to ${domain}, so it would change ${domain} instead. Fix the "${site}=TOKEN" entry on the connection.`
        : `The plugin token configured for ${site} was rejected by Plausible. Create a new one under Site Settings → Integrations → Plugin Tokens.`,
    );
  }
  return client;
}

export function hasManagementBackend(ctx: ToolContext): boolean {
  return Boolean(ctx.sites) || Object.keys(ctx.connection.pluginTokens).length > 0;
}

export function resolveSite(ctx: ToolContext, siteId?: string): string {
  const site = siteId ? normalizeSiteDomain(siteId) : ctx.connection.defaultSite;
  if (!site) {
    throw new ToolInputError(
      'No site_id given and no default site is configured. Pass site_id (the domain as it appears in Plausible, e.g. "example.com"), ' +
      'or add site domains to this connection.',
    );
  }
  return site;
}

// =============================================================================
// Results & errors
// =============================================================================

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(data: unknown): CallToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function describeError(ctx: ToolContext, error: unknown): string {
  if (error instanceof ToolInputError || error instanceof ConnectionConfigError) {
    return error.message;
  }
  if (error instanceof PlausibleApiError) {
    const status = error.status ? ` (${error.status})` : '';
    const hint = hintForError(error, getCachedProfile(ctx.connection.baseUrl));
    return `Plausible API error${status} on ${error.endpoint}: ${error.message}${hint ? `\nHint: ${hint}` : ''}`;
  }
  console.error('Unexpected tool error:', error);
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Run a tool body and turn every failure into an isError result */
export async function runTool(ctx: ToolContext, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return errorResult(describeError(ctx, error));
  }
}

export function requireConfirmation(confirm: boolean | undefined, action: string): void {
  if (confirm !== true) {
    throw new ToolInputError(
      `${action} cannot be undone. Ask the user to confirm explicitly, then call this tool again with confirm: true.`,
    );
  }
}

// =============================================================================
// Annotations
// =============================================================================

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

// =============================================================================
// Common parameter schemas
// =============================================================================

export const siteIdParam = z
  .string()
  .optional()
  .describe('Site domain as configured in Plausible, e.g. "example.com". Optional when the connection has a default site.');

export const dateRangeParam = z
  .union([
    z.string(),
    z.object({
      from: z.string().describe('Start date "YYYY-MM-DD" (inclusive) or ISO datetime with offset'),
      to: z.string().describe('End date "YYYY-MM-DD" (inclusive) or ISO datetime with offset'),
    }),
  ])
  .optional()
  .describe(DATE_RANGE_DESCRIPTION);

export const metricsParam = z.array(z.enum(METRICS)).min(1).optional().describe(`Metrics to return. ${METRICS_DESCRIPTION}`);

export const filtersParam = z
  .array(
    z.object({
      dimension: z.string().describe(DIMENSION_DESCRIPTION),
      operator: z.enum(FILTER_OPERATORS).optional().describe('Default "is". "contains" = substring, "matches" = regex. Goal filters support only is / contains.'),
      values: z.array(z.union([z.string(), z.number()])).min(1).describe('One or more values; a filter matches if any value matches. Page values support wildcards like "/blog/**".'),
      case_sensitive: z.boolean().optional().describe('Set false for case-insensitive matching (is / contains). Plausible CE 3.0+.'),
    }),
  )
  .optional()
  .describe('Filters combined with AND. Example: [{"dimension": "country", "values": ["Malaysia"]}, {"dimension": "page", "operator": "contains", "values": ["/blog"]}]');

export const formatParam = z
  .enum(['markdown', 'json'])
  .optional()
  .describe('Output format: "markdown" (default, compact table) or "json" (named rows + meta).');

export const includeImportsParam = z
  .boolean()
  .optional()
  .describe('Include imported data (Google Analytics / CSV imports). Default false.');

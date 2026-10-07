/**
 * Core tools: connectivity check, instance diagnostics and site listing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { markdownTable } from '../plausible/format.js';
import { describeInstance, getInstanceProfile } from '../plausible/profile.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import {
  READ_ONLY,
  type ToolContext,
  describeError,
  formatParam,
  hasManagementBackend,
  jsonResult,
  pluginsClientFor,
  runTool,
  textResult,
} from './shared.js';

function toolGroups(ctx: ToolContext): Record<string, string> {
  const pluginSites = Object.keys(ctx.connection.pluginTokens);
  return {
    stats: 'enabled',
    management: hasManagementBackend(ctx)
      ? `enabled (${[
        ...(pluginSites.length ? [`Plugins API: ${pluginSites.join(', ')}`] : []),
        ...(ctx.sites ? ['Sites API (Plausible Cloud)'] : []),
      ].join('; ')})`
      : 'disabled — add a Plugin Token for a site to enable goal / shared-link / custom-property tools',
    cloud_site_admin: ctx.sites ? 'enabled' : 'not available (self-hosted Community Edition has no Sites API)',
    write_tools: ctx.connection.allowWrites ? 'enabled' : 'disabled (read-only connection)',
  };
}

export function registerCoreTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // hello
  // ---------------------------------------------------------------------------
  server.registerTool(
    'hello',
    {
      title: 'Hello',
      description: 'Verify that the Plausible Analytics MCP server is reachable and see how this connection is configured.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => jsonResult({
      message: `Hello from ${SERVER_NAME}!`,
      version: SERVER_VERSION,
      timestamp: new Date().toISOString(),
      transport: ctx.transport,
      auth_mode: ctx.authMode,
      instance: ctx.connection.baseUrl,
      edition: ctx.connection.isCloud ? 'cloud' : 'self-hosted',
      default_site: ctx.connection.defaultSite ?? null,
      sites: ctx.connection.sites,
      tool_groups: toolGroups(ctx),
      warnings: ctx.connection.warnings,
    }),
  );

  // ---------------------------------------------------------------------------
  // get_instance_info
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_instance_info',
    {
      title: 'Instance info & diagnostics',
      description:
        'Diagnose the Plausible connection: instance version and edition, health, whether the API key can read the ' +
        'default site, plugin-token validity, which tool groups are enabled, and which metrics / date ranges this ' +
        'instance supports. Use when a query fails or before using newer features.',
      inputSchema: { format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const profile = await getInstanceProfile(ctx.stats, { fresh: true });

      const [health, keyCheck, ...tokenChecks] = await Promise.allSettled([
        profile.edition === 'community' ? ctx.stats.healthReady() : Promise.resolve({ skipped: 'Plausible Cloud' }),
        ctx.connection.defaultSite
          ? ctx.stats.query({ site_id: ctx.connection.defaultSite, metrics: ['visitors'], date_range: 'day' })
          : Promise.reject(new Error('no default site configured')),
        ...Object.keys(ctx.connection.pluginTokens).slice(0, 10).map(site => pluginsClientFor(ctx, site)!.capabilities()),
      ]);

      const pluginSites = Object.keys(ctx.connection.pluginTokens).slice(0, 10);
      const plugin_tokens = Object.fromEntries(pluginSites.map((site, index) => {
        const check = tokenChecks[index];
        if (check.status === 'rejected') return [site, `error: ${describeError(ctx, check.reason)}`];
        return [site, check.value.authorized ? 'valid' : 'rejected'];
      }));

      const notes: string[] = [];
      if (profile.edition === 'community') {
        notes.push('Self-hosted Community Edition: the Sites API is not available, so list_sites uses the site domains configured on this connection.');
        notes.push('Revenue metrics (total_revenue, average_revenue) and the "24h" range are Plausible Cloud only.');
      }
      if (profile.geoDatabase && /country/i.test(profile.geoDatabase) && !/city/i.test(profile.geoDatabase)) {
        notes.push(`Geo database is "${profile.geoDatabase}" (country level) — region and city breakdowns will be empty.`);
      }
      if (!ctx.connection.sites.length) {
        notes.push('No site domains configured — pass site_id to every tool, or add sites to the connection.');
      }
      notes.push(...ctx.connection.warnings);

      const info = {
        instance: ctx.connection.baseUrl,
        description: describeInstance(profile),
        version: profile.version ?? null,
        geo_database: profile.geoDatabase ?? null,
        health: health.status === 'fulfilled' ? health.value : `error: ${describeError(ctx, health.reason)}`,
        api_key_check: keyCheck.status === 'fulfilled'
          ? `ok — can read ${ctx.connection.defaultSite}`
          : `failed — ${keyCheck.reason instanceof Error && keyCheck.reason.message === 'no default site configured' ? keyCheck.reason.message : describeError(ctx, keyCheck.reason)}`,
        default_site: ctx.connection.defaultSite ?? null,
        sites: ctx.connection.sites,
        plugin_tokens,
        tool_groups: toolGroups(ctx),
        supported_metrics: profile.schema?.metrics ?? null,
        supported_date_ranges: profile.schema
          ? [...profile.schema.dateRangeShorthands, ...(profile.schema.supportsRelativeRanges ? ['<N>d', '<N>mo'] : []), 'custom {from, to}']
          : null,
        supported_include_options: profile.schema?.includeKeys ?? null,
        probe_errors: profile.errors,
        notes,
      };

      if (args.format === 'json') return jsonResult(info);

      const lines = [
        '## Plausible instance',
        `- Instance: ${info.instance} — ${info.description}`,
        `- Geo database: ${info.geo_database ?? 'unknown'}`,
        `- Health: ${typeof info.health === 'string' ? info.health : JSON.stringify(info.health)}`,
        `- API key: ${info.api_key_check}`,
        `- Sites: ${info.sites.length ? info.sites.map(site => (site === info.default_site ? `${site} (default)` : site)).join(', ') : 'none configured'}`,
        ...(pluginSites.length ? [`- Plugin tokens: ${Object.entries(plugin_tokens).map(([site, status]) => `${site}: ${status}`).join(', ')}`] : []),
        '',
        '## Tool groups',
        ...Object.entries(info.tool_groups).map(([group, status]) => `- ${group}: ${status}`),
        '',
        '## Supported by this instance',
        `- Metrics: ${info.supported_metrics?.join(', ') ?? 'unknown (schema endpoint unavailable)'}`,
        `- Date ranges: ${info.supported_date_ranges?.join(', ') ?? 'unknown'}`,
        `- Include options: ${info.supported_include_options?.join(', ') ?? 'unknown'}`,
        ...(info.probe_errors.length ? ['', '## Probe errors', ...info.probe_errors.map(error => `- ${error}`)] : []),
        ...(notes.length ? ['', '## Notes', ...notes.map(note => `- ${note}`)] : []),
      ];
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // list_sites
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_sites',
    {
      title: 'List sites',
      description:
        'List the sites available on this connection. On Plausible Cloud this calls the Sites API; on self-hosted ' +
        'Community Edition (no Sites API) it returns the site domains configured on the connection.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Plausible Cloud only: page size (default 100).'),
        after: z.string().optional().describe('Plausible Cloud only: pagination cursor from a previous call.'),
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      if (ctx.sites) {
        const result = await ctx.sites.listSites({ limit: args.limit ?? 100, after: args.after });
        if (args.format === 'json') return jsonResult(result);
        const lines = [
          '## Sites',
          markdownTable(['domain', 'timezone'], result.sites.map(site => ({ domain: site.domain, timezone: site.timezone })), []),
          ...(result.meta?.after ? [`\n_More sites available — call again with after="${result.meta.after}"._`] : []),
        ];
        return textResult(lines.join('\n'));
      }

      const sites = ctx.connection.sites.map(site => ({
        domain: site,
        default: site === ctx.connection.defaultSite,
        plugin_token: Boolean(ctx.connection.pluginTokens[site]),
      }));
      if (args.format === 'json') return jsonResult({ source: 'connection configuration', sites });
      if (!sites.length) {
        return textResult(
          'No sites are configured on this connection, and self-hosted Plausible has no API to list sites.\n' +
          'Pass site_id (the domain shown in your Plausible dashboard) to each tool, or add site domains to the connection ' +
          '("Site Domains" in the MCP Key Service portal, the X-Plausible-Sites header, or PLAUSIBLE_SITES for the CLI).',
        );
      }
      return textResult([
        '## Sites (from connection configuration)',
        markdownTable(
          ['domain', 'default', 'plugin_token'],
          sites.map(site => ({ ...site, default: site.default ? 'yes' : '', plugin_token: site.plugin_token ? 'yes' : '' })),
          [],
        ),
        '',
        '_Self-hosted Plausible has no API to list sites, so this list comes from the connection settings._',
      ].join('\n'));
    }),
  );
}

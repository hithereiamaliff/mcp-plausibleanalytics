/**
 * Management tools — goals, shared links, custom properties, tracker script config.
 *
 * Backend per site:
 *   - Plugins API (self-hosted CE or Cloud) when the connection has a Plugin Token for the site
 *   - Sites API (Plausible Cloud only) otherwise
 * Write tools are only registered when the connection allows writes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { markdownTable, type Row } from '../plausible/format.js';
import { type PluginGoal, type PluginsClient, nextCursor } from '../plausible/plugins-client.js';
import { ToolInputError } from '../plausible/query-helpers.js';
import type { SitesClient } from '../plausible/sites-client.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  type ToolContext,
  WRITE_IDEMPOTENT,
  formatParam,
  jsonResult,
  verifiedPluginsClient,
  requireConfirmation,
  resolveSite,
  runTool,
  siteIdParam,
  textResult,
} from './shared.js';

type Backend =
  | { kind: 'plugins'; client: PluginsClient }
  | { kind: 'sites'; client: SitesClient };

async function backendFor(ctx: ToolContext, site: string): Promise<Backend> {
  const plugins = await verifiedPluginsClient(ctx, site);
  if (plugins) return { kind: 'plugins', client: plugins };
  if (ctx.sites) return { kind: 'sites', client: ctx.sites };
  throw new ToolInputError(
    `No management access for ${site}. On self-hosted Plausible, create a Plugin Token for this site ` +
    `(${ctx.connection.baseUrl}/${site}/settings/integrations?new_token=MCP) and add it to the connection as "${site}=TOKEN".`,
  );
}

function pluginsOnly(backend: Backend, feature: string): PluginsClient {
  if (backend.kind !== 'plugins') {
    throw new ToolInputError(`${feature} needs a Plugin Token for this site (the Sites API has no equivalent endpoint).`);
  }
  return backend.client;
}

function pluginGoalRow(goal: PluginGoal): Row {
  const base = { id: goal.goal.id, display_name: goal.goal.display_name, custom_props: formatProps(goal.goal.custom_props) };
  switch (goal.goal_type) {
    case 'Goal.Pageview':
      return { ...base, type: 'page', target: goal.goal.path };
    case 'Goal.Revenue':
      return { ...base, type: `revenue (${goal.goal.currency})`, target: goal.goal.event_name };
    default:
      return { ...base, type: 'event', target: goal.goal.event_name };
  }
}

function formatProps(props?: Record<string, string>): string {
  if (!props || Object.keys(props).length === 0) return '';
  return Object.entries(props).map(([key, value]) => `${key}=${value}`).join(', ');
}

const GOAL_COLUMNS = ['id', 'type', 'display_name', 'target', 'custom_props'];

export function registerManagementTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // list_goals
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_goals',
    {
      title: 'List goals',
      description: 'List the goals (custom events and pageview goals) configured for a site, with their IDs.',
      inputSchema: {
        site_id: siteIdParam,
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 100).'),
        after: z.string().optional().describe('Pagination cursor from a previous call.'),
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      const limit = args.limit ?? 100;

      let rows: Row[];
      let cursor: string | undefined;
      if (backend.kind === 'plugins') {
        const result = await backend.client.listGoals({ limit, after: args.after });
        rows = result.goals.map(pluginGoalRow);
        cursor = nextCursor(result.meta?.pagination);
      } else {
        const result = await backend.client.listGoals(site, { limit, after: args.after });
        rows = result.goals.map(goal => ({
          id: goal.id,
          type: goal.goal_type,
          display_name: goal.display_name,
          target: goal.goal_type === 'page' ? goal.page_path : goal.event_name,
          custom_props: formatProps(goal.custom_props),
        }));
        cursor = result.meta?.after ?? undefined;
      }

      if (args.format === 'json') return jsonResult({ site_id: site, goals: rows, next_cursor: cursor ?? null });
      return textResult([
        `## Goals — ${site}`,
        rows.length ? markdownTable(GOAL_COLUMNS, rows, []) : '_No goals configured._',
        ...(cursor ? [`\n_More goals available — call again with after="${cursor}"._`] : []),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // list_shared_links (Plugins API only)
  // ---------------------------------------------------------------------------
  if (Object.keys(ctx.connection.pluginTokens).length > 0) {
    server.registerTool(
      'list_shared_links',
      {
        title: 'List shared links',
        description: 'List the public/password-protected shared dashboard links of a site (needs a Plugin Token for the site).',
        inputSchema: { site_id: siteIdParam, format: formatParam },
        annotations: READ_ONLY,
      },
      async args => runTool(ctx, async () => {
        const site = resolveSite(ctx, args.site_id);
        const client = pluginsOnly(await backendFor(ctx, site), 'Listing shared links');
        const result = await client.listSharedLinks({ limit: 100 });
        const rows = result.shared_links.map(({ shared_link }) => ({
          id: shared_link.id,
          name: shared_link.name,
          password_protected: shared_link.password_protected ? 'yes' : 'no',
          url: shared_link.href,
        }));
        if (args.format === 'json') return jsonResult({ site_id: site, shared_links: rows });
        return textResult([
          `## Shared links — ${site}`,
          rows.length ? markdownTable(['id', 'name', 'password_protected', 'url'], rows, []) : '_No shared links._',
        ].join('\n'));
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // get_tracker_config
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_tracker_config',
    {
      title: 'Get tracker script configuration',
      description:
        'Show how the Plausible tracking script is configured for a site (installation type, outbound links, file ' +
        'downloads, form submissions, hash-based routing). Self-hosted needs CE 3.1+ and a Plugin Token.',
      inputSchema: { site_id: siteIdParam, format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      const config = backend.kind === 'plugins'
        ? (await backend.client.getTrackerConfig()).tracker_script_configuration
        : (await backend.client.getSite(site)).tracker_script_configuration ?? {};

      if (args.format === 'json') return jsonResult({ site_id: site, tracker_script_configuration: config });
      return textResult([
        `## Tracker script configuration — ${site}`,
        ...Object.entries(config).map(([key, value]) => `- ${key}: ${String(value)}`),
      ].join('\n'));
    }),
  );

  if (!ctx.connection.allowWrites) return;

  // ---------------------------------------------------------------------------
  // create_goal
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_goal',
    {
      title: 'Create goal',
      description:
        'Create a goal for a site, or return it if it already exists (idempotent). "event" goals count a custom event ' +
        '(e.g. "Signup"); "page" goals count visits to a path (wildcards like "/blog/**" allowed).',
      inputSchema: {
        site_id: siteIdParam,
        goal_type: z.enum(['event', 'page']).describe('"event" for custom events, "page" for pageview goals'),
        event_name: z.string().optional().describe('Event name (required for event goals), e.g. "Signup"'),
        page_path: z.string().optional().describe('Path (required for page goals), e.g. "/register" or "/blog/**"'),
        display_name: z.string().optional().describe('Custom display name (Plausible Cloud only)'),
        custom_props: z.record(z.string()).optional().describe('Only count events with these custom property values (max 3), e.g. {"plan": "pro"}'),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      const eventName = args.event_name?.trim();
      const pagePath = args.page_path?.trim();
      if (args.goal_type === 'event' && !eventName) throw new ToolInputError('event_name is required for event goals.');
      if (args.goal_type === 'page' && !pagePath) throw new ToolInputError('page_path is required for page goals.');
      if (pagePath && !pagePath.startsWith('/')) throw new ToolInputError('page_path must start with "/".');
      if (args.custom_props && Object.keys(args.custom_props).length > 3) {
        throw new ToolInputError('A goal can match at most 3 custom properties.');
      }

      if (backend.kind === 'plugins') {
        const result = await backend.client.createGoal(
          args.goal_type === 'event'
            ? { goal_type: 'Goal.CustomEvent', goal: { event_name: eventName!, custom_props: args.custom_props } }
            : { goal_type: 'Goal.Pageview', goal: { path: pagePath!, custom_props: args.custom_props } },
        );
        const rows = result.goals.map(pluginGoalRow);
        return textResult([`Goal ready on ${site}:`, markdownTable(GOAL_COLUMNS, rows, [])].join('\n'));
      }

      const goal = await backend.client.putGoal({
        site_id: site,
        goal_type: args.goal_type,
        event_name: eventName,
        page_path: pagePath,
        display_name: args.display_name,
        custom_props: args.custom_props,
      });
      return jsonResult({ site_id: site, goal });
    }),
  );

  // ---------------------------------------------------------------------------
  // delete_goal
  // ---------------------------------------------------------------------------
  server.registerTool(
    'delete_goal',
    {
      title: 'Delete goal',
      description: 'Delete a goal by ID (see list_goals). Requires confirm: true after the user explicitly approves.',
      inputSchema: {
        site_id: siteIdParam,
        goal_id: z.union([z.string(), z.number()]).describe('Goal ID from list_goals'),
        confirm: z.boolean().optional().describe('Must be true — confirms the user approved the deletion'),
      },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(ctx, async () => {
      requireConfirmation(args.confirm, 'Deleting a goal');
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      if (backend.kind === 'plugins') {
        await backend.client.deleteGoal(args.goal_id);
      } else {
        await backend.client.deleteGoal(site, args.goal_id);
      }
      return textResult(`Deleted goal ${args.goal_id} from ${site}.`);
    }),
  );

  // ---------------------------------------------------------------------------
  // create_shared_link
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_shared_link',
    {
      title: 'Create shared link',
      description:
        'Create a shared dashboard link for a site, or return the existing one with the same name (idempotent). ' +
        'Anyone with the link can view the dashboard — optionally protect it with a password (Plugin Token only).',
      inputSchema: {
        site_id: siteIdParam,
        name: z.string().min(1).describe('Link name, e.g. "Client dashboard"'),
        password: z.string().optional().describe('Optional password (Plugins API only)'),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      if (backend.kind === 'plugins') {
        const { shared_link } = await backend.client.createSharedLink(args.name, args.password);
        return textResult(`Shared link "${shared_link.name}" for ${site}${shared_link.password_protected ? ' (password protected)' : ''}:\n${shared_link.href}`);
      }
      if (args.password) throw new ToolInputError('Password-protected links need a Plugin Token for this site.');
      const link = await backend.client.putSharedLink(site, args.name);
      return textResult(`Shared link "${link.name}" for ${site}:\n${link.url}`);
    }),
  );

  // ---------------------------------------------------------------------------
  // enable_custom_property / disable_custom_property
  // ---------------------------------------------------------------------------
  const propertiesParam = z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('Custom property keys, e.g. ["author", "plan"]');

  server.registerTool(
    'enable_custom_property',
    {
      title: 'Enable custom properties',
      description:
        'Allow-list custom property keys for a site so they appear in the dashboard and can be queried (idempotent).',
      inputSchema: { site_id: siteIdParam, properties: propertiesParam },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      if (backend.kind === 'plugins') {
        await backend.client.enableCustomProps(args.properties);
      } else {
        for (const property of args.properties) await backend.client.putCustomProp(site, property);
      }
      return textResult(`Enabled custom properties on ${site}: ${args.properties.join(', ')}`);
    }),
  );

  server.registerTool(
    'disable_custom_property',
    {
      title: 'Disable custom properties',
      description:
        'Remove custom property keys from a site\'s allow-list. Collected data is kept, but the properties stop ' +
        'showing in the dashboard. Requires confirm: true after the user approves.',
      inputSchema: {
        site_id: siteIdParam,
        properties: propertiesParam,
        confirm: z.boolean().optional().describe('Must be true — confirms the user approved'),
      },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(ctx, async () => {
      requireConfirmation(args.confirm, 'Disabling custom properties');
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      if (backend.kind === 'plugins') {
        await backend.client.disableCustomProps(args.properties);
      } else {
        for (const property of args.properties) await backend.client.deleteCustomProp(site, property);
      }
      return textResult(`Disabled custom properties on ${site}: ${args.properties.join(', ')}`);
    }),
  );

  // ---------------------------------------------------------------------------
  // update_tracker_config
  // ---------------------------------------------------------------------------
  server.registerTool(
    'update_tracker_config',
    {
      title: 'Update tracker script configuration',
      description:
        'Change tracker script options for a site. Only the options you pass are changed. After changing options, ' +
        'the site may need the updated snippet (shown in Plausible Site Settings). Self-hosted needs CE 3.1+.',
      inputSchema: {
        site_id: siteIdParam,
        installation_type: z.enum(['manual', 'wordpress', 'gtm', 'npm']).optional(),
        outbound_links: z.boolean().optional(),
        file_downloads: z.boolean().optional(),
        form_submissions: z.boolean().optional(),
        hash_based_routing: z.boolean().optional(),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const backend = await backendFor(ctx, site);
      const { site_id: _site, ...changes } = args;
      const updates = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      if (Object.keys(updates).length === 0) throw new ToolInputError('Pass at least one option to change.');

      if (backend.kind === 'plugins') {
        // installation_type is required by the Plugins API — keep the current one if not given
        const current = (await backend.client.getTrackerConfig()).tracker_script_configuration;
        const { id: _id, ...currentOptions } = current;
        const result = await backend.client.updateTrackerConfig({
          ...currentOptions,
          ...updates,
          // Sites that never chose an installation type report null, which the PUT rejects
          installation_type: args.installation_type ?? currentOptions.installation_type ?? 'manual',
        });
        return jsonResult({ site_id: site, tracker_script_configuration: result.tracker_script_configuration });
      }

      const updated = await backend.client.updateSite(site, { tracker_script_configuration: updates });
      return jsonResult({ site_id: site, tracker_script_configuration: updated.tracker_script_configuration });
    }),
  );
}

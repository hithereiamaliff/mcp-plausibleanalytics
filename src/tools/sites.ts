/**
 * Plausible Cloud site administration (Sites API).
 *
 * Only registered for plausible.io connections — self-hosted Community Edition does not
 * ship the Sites API. Reads work with a Stats API key; writes need a Sites API key
 * (Enterprise plan) and a connection that allows writes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SitesClient } from '../plausible/sites-client.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  type ToolContext,
  WRITE,
  jsonResult,
  requireConfirmation,
  resolveSite,
  runTool,
  siteIdParam,
  textResult,
} from './shared.js';

export function registerSiteAdminTools(server: McpServer, ctx: ToolContext, sites: SitesClient): void {
  server.registerTool(
    'get_site',
    {
      title: 'Get site (Cloud)',
      description: 'Plausible Cloud: site details — domain, timezone, allowed custom properties and tracker script configuration.',
      inputSchema: { site_id: siteIdParam },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => jsonResult(await sites.getSite(resolveSite(ctx, args.site_id)))),
  );

  server.registerTool(
    'list_custom_properties',
    {
      title: 'List custom properties (Cloud)',
      description: 'Plausible Cloud: list the custom property keys allow-listed for a site.',
      inputSchema: { site_id: siteIdParam },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const { custom_properties } = await sites.listCustomProps(site);
      return textResult(
        custom_properties.length
          ? `Custom properties on ${site}: ${custom_properties.map(item => item.property).join(', ')}`
          : `No custom properties are allow-listed on ${site}.`,
      );
    }),
  );

  if (!ctx.connection.allowWrites) return;

  server.registerTool(
    'create_site',
    {
      title: 'Create site (Cloud)',
      description: 'Plausible Cloud (Sites API key): add a new site. The domain must be globally unique in Plausible.',
      inputSchema: {
        domain: z.string().min(1).describe('Domain of the new site, e.g. "example.com"'),
        timezone: z.string().optional().describe('IANA timezone, e.g. "Asia/Kuala_Lumpur" (default Etc/UTC)'),
        team_id: z.string().optional().describe('Team to create the site in (default: the key\'s team)'),
      },
      annotations: WRITE,
    },
    async args => runTool(ctx, async () => jsonResult(await sites.createSite(args))),
  );

  server.registerTool(
    'update_site',
    {
      title: 'Update site (Cloud)',
      description: 'Plausible Cloud (Sites API key): change a site\'s domain. Stats keep working under the old domain too.',
      inputSchema: {
        site_id: siteIdParam,
        domain: z.string().min(1).describe('New domain'),
      },
      annotations: WRITE,
    },
    async args => runTool(ctx, async () => jsonResult(await sites.updateSite(resolveSite(ctx, args.site_id), { domain: args.domain }))),
  );

  server.registerTool(
    'delete_site',
    {
      title: 'Delete site (Cloud)',
      description:
        'Plausible Cloud (Sites API key): permanently delete a site and ALL of its data. Irreversible; data removal can ' +
        'take up to 48 hours. Requires confirm: true after the user explicitly approves.',
      inputSchema: {
        site_id: z.string().min(1).describe('Domain of the site to delete (no default — must be explicit)'),
        confirm: z.boolean().optional().describe('Must be true — confirms the user approved the permanent deletion'),
      },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(ctx, async () => {
      requireConfirmation(args.confirm, `Deleting the site ${args.site_id} and all of its data`);
      await sites.deleteSite(resolveSite(ctx, args.site_id));
      return textResult(`Site ${args.site_id} scheduled for deletion. Its data will be removed within 48 hours.`);
    }),
  );
}

/**
 * Plausible Analytics - Sites API v1 Tools
 * Provides tools for managing sites, goals, shared links, and custom properties
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlausibleClient } from '../plausible-client.js';

/**
 * Register all Sites API tools on the given MCP server
 */
export function registerSitesTools(server: McpServer, getClient: () => PlausibleClient): void {

  // =========================================================================
  // list_sites - List all sites
  // =========================================================================
  server.tool(
    'list_sites',
    'List all sites in your Plausible account. Returns domains and timezones. Requires a Sites API key (Enterprise plan).',
    {
      limit: z.number().optional().describe('Number of results per page (default: 100)'),
      after: z.string().optional().describe('Pagination cursor for next page'),
      before: z.string().optional().describe('Pagination cursor for previous page'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.listSites({
          limit: args.limit,
          after: args.after,
          before: args.before,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // get_site - Get site details
  // =========================================================================
  server.tool(
    'get_site',
    'Get details of a specific site including domain, timezone, custom properties, and tracker script configuration. Requires a Sites API key.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.getSite(args.site_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // create_site - Create a new site
  // =========================================================================
  server.tool(
    'create_site',
    'Create a new site in your Plausible account. The domain must be globally unique. Requires a Sites API key.',
    {
      domain: z.string().describe('Domain for the new site (e.g. "example.com"). Must be globally unique.'),
      timezone: z.string().optional().describe('IANA timezone (e.g. "Europe/London", "Asia/Kuala_Lumpur"). Defaults to "Etc/UTC".'),
      team_id: z.string().optional().describe('Team ID to create the site under. Defaults to "My Personal Sites".'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.createSite({
          domain: args.domain,
          timezone: args.timezone,
          team_id: args.team_id,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // update_site - Update site settings
  // =========================================================================
  server.tool(
    'update_site',
    'Update an existing site in your Plausible account. Can change the domain name. Requires a Sites API key.',
    {
      site_id: z.string().describe('Current domain of the site to update'),
      domain: z.string().optional().describe('New domain name for the site'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.updateSite(args.site_id, {
          domain: args.domain,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // delete_site - Delete a site
  // =========================================================================
  server.tool(
    'delete_site',
    'Permanently delete a site and ALL its data from Plausible. This action cannot be undone. Deletion may take up to 48 hours. Requires a Sites API key.',
    {
      site_id: z.string().describe('Domain of the site to delete (e.g. "example.com")'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.deleteSite(args.site_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // create_shared_link - Find or create a shared link
  // =========================================================================
  server.tool(
    'create_shared_link',
    'Find or create a shared link for embedding a public dashboard. Idempotent - won\'t fail if the link already exists. Returns the shareable URL. Requires a Sites API key.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
      name: z.string().describe('Name for the shared link (e.g. "WordPress", "Public Dashboard")'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.createSharedLink(args.site_id, args.name);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // list_goals - List goals for a site
  // =========================================================================
  server.tool(
    'list_goals',
    'List all goals configured for a site. Goals can be custom events or page visits. Requires a Sites API key.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
      limit: z.number().optional().describe('Number of results per page (default: 100)'),
      after: z.string().optional().describe('Pagination cursor for next page'),
      before: z.string().optional().describe('Pagination cursor for previous page'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.listGoals(args.site_id, {
          limit: args.limit,
          after: args.after,
          before: args.before,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // create_goal - Find or create a goal
  // =========================================================================
  server.tool(
    'create_goal',
    'Find or create a goal for a site. Goals can be custom events (e.g. "Signup") or page visits (e.g. "/register"). Idempotent - won\'t fail if the goal already exists. Requires a Sites API key.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
      goal_type: z.enum(['event', 'page']).describe('Type of goal: "event" for custom events, "page" for pageview goals'),
      event_name: z.string().optional().describe('Event name (required if goal_type is "event"). E.g. "Signup", "Purchase"'),
      page_path: z.string().optional().describe('Page path (required if goal_type is "page"). E.g. "/register". Supports wildcards.'),
      display_name: z.string().optional().describe('Custom display name for the goal in the dashboard'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.createGoal({
          site_id: args.site_id,
          goal_type: args.goal_type,
          event_name: args.event_name,
          page_path: args.page_path,
          display_name: args.display_name,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // delete_goal - Delete a goal
  // =========================================================================
  server.tool(
    'delete_goal',
    'Delete a goal from a site. Requires the goal ID and site domain. Requires a Sites API key.',
    {
      goal_id: z.string().describe('ID of the goal to delete'),
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.deleteGoal(args.goal_id, args.site_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // =========================================================================
  // check_plausible_health - Check API health
  // =========================================================================
  server.tool(
    'check_plausible_health',
    'Check if the Plausible Analytics API is healthy and accessible. Returns the health status of the configured Plausible instance.',
    {},
    async () => {
      try {
        const client = getClient();
        const result = await client.checkHealth();
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'healthy', response: result }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'unhealthy', error: error instanceof Error ? error.message : String(error) }, null, 2) }],
          isError: true,
        };
      }
    }
  );
}

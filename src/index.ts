/**
 * Plausible Analytics MCP Server — shared server factory.
 *
 * Used by both entry points:
 *   - src/cli.ts          stdio transport (npx / local MCP clients)
 *   - src/http-server.ts  Streamable HTTP transport (VPS, per-request servers)
 *
 * Tools are registered per connection, so a client only sees what its credentials can do:
 *   core + stats         always
 *   management           Plugin Token for a site (self-hosted) or Plausible Cloud
 *   cloud site admin     Plausible Cloud only (Sites API)
 *   writes / events      only when the connection allows writes
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlausibleConnection } from './config.js';
import { registerCoreTools } from './tools/core.js';
import { registerEventTools } from './tools/events.js';
import { registerManagementTools } from './tools/management.js';
import { createToolContext, hasManagementBackend, type ToolContext } from './tools/shared.js';
import { registerSiteAdminTools } from './tools/sites.js';
import { registerStatsTools } from './tools/stats.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerCoreTools(server, ctx);
  registerStatsTools(server, ctx);
  if (hasManagementBackend(ctx)) registerManagementTools(server, ctx);
  if (ctx.sites) registerSiteAdminTools(server, ctx, ctx.sites);
  if (ctx.connection.allowWrites) registerEventTools(server, ctx);
}

export function createAppServer(
  connection: PlausibleConnection,
  options: { transport: ToolContext['transport']; authMode: string },
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Plausible Analytics tools. Start with get_site_overview for general questions, use get_breakdown / ' +
        'get_timeseries / compare_periods for specifics, and query_stats for anything custom. site_id is the site ' +
        'domain; it can be omitted when the connection has a default site (see hello or list_sites). If a query ' +
        'fails, get_instance_info explains what this Plausible instance supports.',
    },
  );

  registerAllTools(server, createToolContext(connection, options));
  return server;
}

/** True when this file is the process entry point (handles `node dist/index`, symlinks, path casing) */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (file: string) => {
    try {
      return fs.realpathSync.native(file);
    } catch {
      return undefined;
    }
  };
  const self = real(fileURLToPath(import.meta.url));
  return Boolean(self) && [entry, `${entry}.js`].some(candidate => real(candidate) === self);
}

// Backward compatibility: v1 ran `node dist/index.js` as the stdio entry point (with .env loading)
if (isEntryPoint()) {
  try {
    process.loadEnvFile();
  } catch {
    // no .env in the working directory
  }
  void import('./cli.js');
}

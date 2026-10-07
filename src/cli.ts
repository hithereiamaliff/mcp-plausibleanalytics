#!/usr/bin/env node
/**
 * Plausible Analytics MCP Server — stdio entry point (npx / Claude Desktop / Cursor / …).
 * All logging goes to stderr; stdout is reserved for the MCP protocol.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionConfigError, normalizeConnection } from './config.js';
import { createAppServer } from './index.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

async function main() {
  const { PLAUSIBLE_API_KEY, PLAUSIBLE_URL, PLAUSIBLE_API_URL, PLAUSIBLE_SITES, PLAUSIBLE_PLUGIN_TOKENS, PLAUSIBLE_ALLOW_WRITES } = process.env;

  if (!PLAUSIBLE_API_KEY) {
    console.error('ERROR: Missing required environment variable PLAUSIBLE_API_KEY (a Plausible Stats API key).');
    console.error('\nCreate one in Plausible → Account Settings → API Keys, then set it in your MCP client config:');
    console.error('  PLAUSIBLE_API_KEY        required  Stats API key');
    console.error('  PLAUSIBLE_URL            optional  Self-hosted instance URL (default https://plausible.io)');
    console.error('  PLAUSIBLE_SITES          optional  Comma-separated site domains; the first is the default');
    console.error('  PLAUSIBLE_PLUGIN_TOKENS  optional  "example.com=TOKEN,..." enables goal / shared-link tools');
    console.error('  PLAUSIBLE_ALLOW_WRITES   optional  "yes" to enable tools that change data');
    process.exit(1);
  }

  let connection;
  try {
    connection = normalizeConnection({
      apiKey: PLAUSIBLE_API_KEY,
      url: PLAUSIBLE_URL || PLAUSIBLE_API_URL,
      sites: PLAUSIBLE_SITES,
      pluginTokens: PLAUSIBLE_PLUGIN_TOKENS,
      allowWrites: PLAUSIBLE_ALLOW_WRITES,
    });
  } catch (error) {
    if (error instanceof ConnectionConfigError) {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  for (const warning of connection.warnings) console.error(`Warning: ${warning}`);

  const server = createAppServer(connection, { transport: 'stdio', authMode: 'cli' });
  await server.connect(new StdioServerTransport());

  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
  console.error(`Instance: ${connection.baseUrl}${connection.defaultSite ? ` · default site: ${connection.defaultSite}` : ''}`);
  console.error(`Write tools: ${connection.allowWrites ? 'enabled' : 'disabled'}`);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

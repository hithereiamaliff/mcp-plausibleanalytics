#!/usr/bin/env node

/**
 * Plausible Analytics MCP Server - STDIO Entry Point
 * For use with MCP clients like Claude Desktop, Cursor, Windsurf via STDIO transport.
 * For VPS/HTTP deployment, use http-server.ts instead.
 */

import dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PlausibleClient } from './plausible-client.js';
import { registerStatsTools } from './tools/stats.js';
import { registerEventsTools } from './tools/events.js';
import { registerSitesTools } from './tools/sites.js';

// Configuration from environment variables
const PLAUSIBLE_API_URL = process.env.PLAUSIBLE_API_URL || 'https://plausible.io';
const PLAUSIBLE_API_KEY = process.env.PLAUSIBLE_API_KEY;

if (!PLAUSIBLE_API_KEY) {
  console.error('Error: PLAUSIBLE_API_KEY environment variable is required');
  process.exit(1);
}

// Create Plausible API client
const plausibleClient = new PlausibleClient({
  apiUrl: PLAUSIBLE_API_URL,
  apiKey: PLAUSIBLE_API_KEY,
});

// Create MCP server
const server = new McpServer({
  name: 'Plausible Analytics MCP Server',
  version: '1.0.0',
});

// Client accessor for tools
const getClient = () => plausibleClient;

// Register all tools
registerStatsTools(server, getClient);
registerEventsTools(server, getClient);
registerSitesTools(server, getClient);

// Register hello tool for testing
server.tool(
  'hello',
  'A simple test tool to verify that the Plausible Analytics MCP server is working correctly',
  {},
  async () => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            message: 'Hello from Plausible Analytics MCP!',
            timestamp: new Date().toISOString(),
            apiUrl: PLAUSIBLE_API_URL,
            transport: 'stdio',
          }, null, 2),
        },
      ],
    };
  }
);

// Start STDIO transport
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Plausible Analytics MCP Server running on stdio');
  console.error(`API URL: ${PLAUSIBLE_API_URL}`);
}

runServer().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});

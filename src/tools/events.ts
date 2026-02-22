/**
 * Plausible Analytics - Events API Tools
 * Provides tools for recording pageviews and custom events via the Events API
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlausibleClient } from '../plausible-client.js';

/**
 * Register all Events API tools on the given MCP server
 */
export function registerEventsTools(server: McpServer, getClient: () => PlausibleClient): void {

  // =========================================================================
  // send_event - Record a custom event or pageview
  // =========================================================================
  server.tool(
    'send_event',
    'Record a pageview or custom event via the Plausible Events API. Use name "pageview" for pageviews, or any other name for custom events. Useful for server-side tracking or mobile app analytics.',
    {
      domain: z.string().describe('Domain of the site in Plausible (e.g. "example.com")'),
      name: z.string().describe('Event name. Use "pageview" for pageviews, or any custom name for custom events (e.g. "Signup", "Purchase")'),
      url: z.string().describe('URL where the event occurred (e.g. "https://example.com/pricing"). For mobile apps, use format like "app://localhost/screen-name"'),
      referrer: z.string().optional().describe('Referrer URL for this event'),
      props: z.record(z.string()).optional().describe('Custom properties as key-value pairs (max 30 pairs). Example: {"author": "John", "plan": "premium"}'),
      revenue: z.object({
        currency: z.string().describe('ISO 4217 currency code (e.g. "USD", "EUR")'),
        amount: z.union([z.string(), z.number()]).describe('Revenue amount (e.g. 29.99 or "29.99")'),
      }).optional().describe('Revenue data for revenue goal tracking'),
      user_agent: z.string().optional().describe('User-Agent header for unique visitor counting. Required for accurate visitor tracking.'),
      ip: z.string().optional().describe('Client IP address via X-Forwarded-For for unique visitor counting and geolocation.'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.sendEvent({
          domain: args.domain,
          name: args.name,
          url: args.url,
          referrer: args.referrer,
          props: args.props,
          revenue: args.revenue,
          userAgent: args.user_agent,
          ip: args.ip,
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
  // send_pageview - Simplified pageview recording
  // =========================================================================
  server.tool(
    'send_pageview',
    'Record a pageview event. A simplified wrapper around send_event specifically for tracking page visits.',
    {
      domain: z.string().describe('Domain of the site in Plausible (e.g. "example.com")'),
      url: z.string().describe('Full URL of the page visited (e.g. "https://example.com/blog/post-1")'),
      referrer: z.string().optional().describe('Referrer URL'),
      user_agent: z.string().optional().describe('User-Agent for visitor identification'),
      ip: z.string().optional().describe('Client IP for geolocation'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.sendEvent({
          domain: args.domain,
          name: 'pageview',
          url: args.url,
          referrer: args.referrer,
          userAgent: args.user_agent,
          ip: args.ip,
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
}

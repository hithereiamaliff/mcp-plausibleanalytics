/**
 * Events API — send a pageview or custom event (write; opt-in only).
 *
 * Events are recorded as real traffic and cannot be removed through the API, so this tool
 * is only registered when the connection allows writes, and is framed for testing goals
 * and server-side tracking setups.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolInputError } from '../plausible/query-helpers.js';
import { type ToolContext, WRITE, resolveSite, runTool, siteIdParam, textResult } from './shared.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function registerEventTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'send_event',
    {
      title: 'Send event',
      description:
        'Record a pageview or custom event through the Plausible Events API — e.g. to test a new goal or server-side ' +
        'tracking. WARNING: events are counted as real traffic and cannot be deleted; prefer a test site and only send ' +
        'events the user explicitly asked for. Visitor uniqueness and location come from user_agent + ip; if ip is ' +
        'omitted, this server\'s IP is used.',
      inputSchema: {
        site_id: siteIdParam,
        name: z.string().max(120).optional().describe('"pageview" (default) or a custom event name, e.g. "Signup"'),
        url: z.string().max(2000).describe('Page URL where the event happened, e.g. "https://example.com/pricing" (UTM tags are parsed)'),
        referrer: z.string().optional().describe('Referrer URL'),
        props: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Custom properties (max 30), e.g. {"plan": "pro"}'),
        revenue: z
          .object({ currency: z.string().length(3), amount: z.union([z.string(), z.number()]) })
          .optional()
          .describe('Revenue for revenue goals (Plausible Cloud only), e.g. {"currency": "MYR", "amount": 49}'),
        interactive: z.boolean().optional().describe('false = does not affect bounce rate (CE 3.1+)'),
        user_agent: z.string().optional().describe('Visitor User-Agent (default: a desktop Chrome UA)'),
        ip: z.string().optional().describe('Visitor IP for uniqueness and geolocation (sent as X-Forwarded-For)'),
      },
      annotations: WRITE,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      if (args.props && Object.keys(args.props).length > 30) {
        throw new ToolInputError('An event can have at most 30 custom properties.');
      }
      try {
        new URL(args.url);
      } catch {
        throw new ToolInputError(`url must be an absolute URL, e.g. "https://${site}/pricing".`);
      }

      const name = args.name?.trim() || 'pageview';
      const { status, dropped } = await ctx.stats.sendEvent(
        {
          domain: site,
          name,
          url: args.url,
          referrer: args.referrer,
          props: args.props,
          revenue: args.revenue,
          interactive: args.interactive,
        },
        { userAgent: args.user_agent?.trim() || DEFAULT_USER_AGENT, ip: args.ip?.trim() || undefined },
      );

      if (dropped > 0) {
        return textResult(
          `Plausible accepted the request (HTTP ${status}) but dropped ${dropped} event(s) — usually bot filtering, ` +
          'Shields (blocked IP/country/page/hostname) or an unknown domain. Check user_agent and ip.',
        );
      }
      return textResult(`Recorded "${name}" on ${site} for ${args.url} (HTTP ${status}). It appears in realtime stats within seconds.`);
    }),
  );
}

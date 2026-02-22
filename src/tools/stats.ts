/**
 * Plausible Analytics - Stats API v2 Tools
 * Provides tools for querying analytics data via the Stats API v2
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlausibleClient } from '../plausible-client.js';

/**
 * Register all Stats API tools on the given MCP server
 */
export function registerStatsTools(server: McpServer, getClient: () => PlausibleClient): void {

  // =========================================================================
  // query_stats - Full Stats API v2 query
  // =========================================================================
  server.tool(
    'query_stats',
    'Query analytics data from Plausible Stats API v2. Supports metrics, dimensions, filters, ordering, and pagination. This is the primary tool for retrieving analytics data.',
    {
      site_id: z.string().describe('Domain of the site to query (e.g. "example.com")'),
      metrics: z.array(z.string()).describe(
        'Metrics to retrieve. Options: visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration, events, scroll_depth, percentage, conversion_rate, group_conversion_rate, average_revenue, total_revenue, time_on_page'
      ),
      date_range: z.union([
        z.string(),
        z.array(z.string()),
      ]).describe(
        'Date range. Use strings like "day", "7d", "30d", "month", "6mo", "12mo", "year", "all", or an array of two ISO8601 dates like ["2024-01-01", "2024-07-01"]'
      ),
      dimensions: z.array(z.string()).optional().describe(
        'Dimensions to group by. Examples: "event:page", "visit:source", "visit:country_name", "visit:browser", "visit:device", "time", "time:day", "time:month"'
      ),
      filters: z.array(z.any()).optional().describe(
        'Filters array. Each filter is [operator, dimension, clauses]. Operators: "is", "is_not", "contains", "contains_not", "matches", "matches_not". Example: [["is", "visit:country_name", ["Germany"]]]'
      ),
      order_by: z.array(z.array(z.string())).optional().describe(
        'Custom ordering. Array of [dimension_or_metric, direction]. Example: [["visitors", "desc"]]'
      ),
      include: z.object({
        imports: z.boolean().optional(),
        time_labels: z.boolean().optional(),
        total_rows: z.boolean().optional(),
      }).optional().describe('Additional data to include in the response'),
      pagination: z.object({
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional().describe('Pagination options'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.query({
          site_id: args.site_id,
          metrics: args.metrics,
          date_range: args.date_range,
          dimensions: args.dimensions,
          filters: args.filters,
          order_by: args.order_by as Array<[string, string]> | undefined,
          include: args.include,
          pagination: args.pagination,
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
  // get_realtime_visitors - Real-time visitor count
  // =========================================================================
  server.tool(
    'get_realtime_visitors',
    'Get the current number of real-time visitors on a site. Returns a single number representing people currently on the site.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
    },
    async (args) => {
      try {
        const client = getClient();
        const result = await client.getRealtimeVisitors(args.site_id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ realtime_visitors: result, site_id: args.site_id, timestamp: new Date().toISOString() }, null, 2) }],
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
  // get_aggregate_stats - Simplified aggregate statistics
  // =========================================================================
  server.tool(
    'get_aggregate_stats',
    'Get aggregate statistics for a site over a date range. A simplified wrapper around the Stats API that returns key metrics without dimensions. Perfect for quick site overview.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
      date_range: z.union([
        z.string(),
        z.array(z.string()),
      ]).describe('Date range: "day", "7d", "30d", "month", "6mo", "12mo", "year", "all", or ["2024-01-01", "2024-07-01"]'),
      metrics: z.array(z.string()).optional().describe(
        'Metrics to retrieve. Defaults to ["visitors", "visits", "pageviews", "views_per_visit", "bounce_rate", "visit_duration"]'
      ),
    },
    async (args) => {
      try {
        const client = getClient();
        const metrics = args.metrics || ['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration'];
        const result = await client.query({
          site_id: args.site_id,
          metrics,
          date_range: args.date_range,
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
  // get_timeseries - Time-series data
  // =========================================================================
  server.tool(
    'get_timeseries',
    'Get time-series analytics data for a site. Returns data points grouped by time intervals (hour, day, week, month). Useful for charting trends over time.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
      date_range: z.union([
        z.string(),
        z.array(z.string()),
      ]).describe('Date range: "day", "7d", "30d", "month", "6mo", "12mo", "year", "all", or ["2024-01-01", "2024-07-01"]'),
      metrics: z.array(z.string()).optional().describe(
        'Metrics to retrieve. Defaults to ["visitors", "visits", "pageviews"]'
      ),
      interval: z.enum(['hour', 'day', 'week', 'month']).optional().describe(
        'Time grouping interval. Options: "hour", "day", "week", "month". Defaults to auto-detection based on date range.'
      ),
      filters: z.array(z.any()).optional().describe('Filters to apply'),
    },
    async (args) => {
      try {
        const client = getClient();
        const metrics = args.metrics || ['visitors', 'visits', 'pageviews'];
        const dimensions: string[] = [];

        if (args.interval) {
          dimensions.push(`time:${args.interval}`);
        } else {
          dimensions.push('time');
        }

        const result = await client.query({
          site_id: args.site_id,
          metrics,
          date_range: args.date_range,
          dimensions,
          filters: args.filters,
          include: { time_labels: true },
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
  // get_breakdown - Breakdown by dimension
  // =========================================================================
  server.tool(
    'get_breakdown',
    'Get analytics data broken down by a specific dimension. Useful for seeing top pages, traffic sources, countries, browsers, devices, etc.',
    {
      site_id: z.string().describe('Domain of the site (e.g. "example.com")'),
      date_range: z.union([
        z.string(),
        z.array(z.string()),
      ]).describe('Date range: "day", "7d", "30d", "month", "6mo", "12mo", "year", "all", or ["2024-01-01", "2024-07-01"]'),
      dimension: z.string().describe(
        'Dimension to break down by. Examples: "event:page" (top pages), "visit:source" (traffic sources), "visit:country_name" (countries), "visit:browser" (browsers), "visit:device" (devices), "visit:os" (operating systems), "visit:entry_page" (landing pages), "visit:exit_page" (exit pages), "visit:utm_source", "visit:utm_medium", "visit:utm_campaign"'
      ),
      metrics: z.array(z.string()).optional().describe(
        'Metrics to retrieve. Defaults to ["visitors", "visits", "pageviews"]'
      ),
      filters: z.array(z.any()).optional().describe('Filters to apply'),
      limit: z.number().optional().describe('Maximum number of results to return (default: 100)'),
    },
    async (args) => {
      try {
        const client = getClient();
        const metrics = args.metrics || ['visitors', 'visits', 'pageviews'];
        const result = await client.query({
          site_id: args.site_id,
          metrics,
          date_range: args.date_range,
          dimensions: [args.dimension],
          filters: args.filters,
          pagination: args.limit ? { limit: args.limit } : undefined,
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

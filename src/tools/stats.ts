/**
 * Stats tools (read-only) — Stats API v2, plus the v1 realtime endpoint.
 * Work on self-hosted Community Edition and Plausible Cloud with a Stats API key.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DateRange, V2Query, V2QueryResponse } from '../plausible/client.js';
import {
  describeFilters,
  describePeriod,
  formatChange,
  formatMetricValue,
  markdownTable,
  metaNotes,
  type Row,
  toRows,
  zeroFillTimeseries,
} from '../plausible/format.js';
import { PlausibleApiError } from '../plausible/http.js';
import { getInstanceProfile } from '../plausible/profile.js';
import {
  type CompareMode,
  DIMENSION_DESCRIPTION,
  FILTER_OPERATORS,
  METRICS,
  type Metric,
  SESSION_ONLY_DIMENSIONS,
  ToolInputError,
  buildFilters,
  comparisonRange,
  computeChange,
  dimensionLabel,
  filtersMention,
  isTimeDimension,
  offsetOf,
  resolveDateRange,
  resolveDimension,
  withOffsets,
} from '../plausible/query-helpers.js';
import {
  READ_ONLY,
  type ToolContext,
  dateRangeParam,
  filtersParam,
  formatParam,
  includeImportsParam,
  jsonResult,
  metricsParam,
  resolveSite,
  runTool,
  siteIdParam,
  textResult,
} from './shared.js';

const DEFAULT_KPI_METRICS: Metric[] = ['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration'];
const MAX_MARKDOWN_ROWS = 400;

const compareParam = z
  .enum(['none', 'previous_period', 'year_over_year'])
  .optional()
  .describe('Compare against the previous period of equal length or the same period last year.');

// =============================================================================
// Helpers
// =============================================================================

function buildInclude(includeImports: boolean | undefined, extra: Record<string, boolean> = {}): Record<string, boolean> {
  return { ...(includeImports ? { imports: true } : {}), ...extra };
}

/**
 * For "day" / "month" / "year" comparisons, trim the current period to "now" so a
 * month-to-date is compared with the same days of last month (CE 3.1+ / Cloud).
 */
async function trimForComparison(ctx: ToolContext, dateRange: DateRange, compare: string | undefined): Promise<Record<string, boolean>> {
  if (!compare || compare === 'none' || typeof dateRange !== 'string' || !['day', 'month', 'year'].includes(dateRange)) {
    return {};
  }
  const profile = await getInstanceProfile(ctx.stats).catch(() => undefined);
  return profile?.schema?.includeKeys.includes('trim_relative_date_range') ? { trim_relative_date_range: true } : {};
}

function heading(title: string, site: string): string {
  return `## ${title} — ${site}`;
}

function periodLine(current?: [string, string], previous?: [string, string]): string {
  return previous
    ? `Period: ${describePeriod(current)} · compared with ${describePeriod(previous)}`
    : `Period: ${describePeriod(current)}`;
}

function filterLine(filters: unknown[]): string[] {
  const text = describeFilters(filters);
  return text ? [`Filters: ${text}`] : [];
}

function firstRow(response: V2QueryResponse, metrics: string[]): Row {
  return toRows(response, [], metrics)[0] ?? Object.fromEntries(metrics.map(metric => [metric, null]));
}

interface KpiComparison {
  metric: string;
  value: unknown;
  previous?: unknown;
  change?: string;
}

function kpiComparison(metrics: string[], current: Row, previous?: Row): KpiComparison[] {
  return metrics.map(metric => ({
    metric,
    value: current[metric],
    ...(previous
      ? { previous: previous[metric], change: formatChange(computeChange(metric, current[metric], previous[metric])) }
      : {}),
  }));
}

function kpiTable(rows: KpiComparison[]): string {
  const withPrevious = rows.some(row => 'previous' in row);
  const columns = withPrevious ? ['metric', 'value', 'previous', 'change'] : ['metric', 'value'];
  return markdownTable(
    columns,
    rows.map(row => ({
      metric: row.metric,
      value: formatMetricValue(row.metric, row.value),
      previous: formatMetricValue(row.metric, row.previous),
      change: row.change,
    })),
    [],
  );
}

/** Run the comparison query for an already-executed current query */
async function runComparison(
  ctx: ToolContext,
  current: V2QueryResponse,
  query: V2Query,
  compare: CompareMode | { from: string; to: string },
  originalRange: DateRange,
): Promise<{ response: V2QueryResponse; range: [string, string] } | undefined> {
  let range: [string, string] | undefined;
  if (typeof compare === 'object') {
    range = resolveDateRange(compare) as [string, string];
  } else if (current.query?.date_range) {
    range = comparisonRange(current.query.date_range, compare, originalRange);
    // Wall-clock shifts of partial-day ranges reuse the current UTC offset; use the site's
    // offsets on the comparison dates instead so DST changes don't skew the window.
    const exactDuration = compare === 'previous_period' && (originalRange === '24h' || Array.isArray(originalRange));
    if (range && range[0].length > 10 && !exactDuration) {
      range = await withSiteOffsets(ctx, query.site_id, range);
    }
  }
  if (!range) return undefined;

  const { trim_relative_date_range: _trim, ...include } = query.include ?? {};
  const response = await ctx.stats.query({ ...query, date_range: range, include });
  return { response, range: response.query?.date_range ?? range };
}

/** Ask Plausible how the comparison dates resolve in the site timezone and take its offsets */
async function withSiteOffsets(ctx: ToolContext, siteId: string, range: [string, string]): Promise<[string, string]> {
  const probe = await ctx.stats.query({
    site_id: siteId,
    metrics: ['visitors'],
    date_range: [range[0].slice(0, 10), range[1].slice(0, 10)],
  });
  const resolved = probe.query?.date_range;
  return resolved ? withOffsets(range, offsetOf(resolved[0]), offsetOf(resolved[1])) : range;
}

function defaultBreakdownMetrics(dimensions: string[]): Metric[] {
  if (dimensions.some(isTimeDimension)) return ['visitors', 'pageviews'];
  if (dimensions.includes('event:goal')) return ['visitors', 'events', 'conversion_rate'];
  if (dimensions.some(d => d.startsWith('event:props:') || d === 'event:name')) return ['visitors', 'events'];
  // Plausible only allows session metrics (bounce_rate) with event dimensions when they are exactly ["event:page"]
  if (dimensions.length === 1 && dimensions[0] === 'event:page') return ['visitors', 'pageviews', 'bounce_rate'];
  if (dimensions.every(d => d === 'event:page' || d === 'event:hostname')) return ['visitors', 'pageviews'];
  if (dimensions.every(d => d.startsWith('visit:'))) {
    return dimensions.some(d => d.includes('entry_page') || d.includes('exit_page'))
      ? ['visitors', 'visits', 'bounce_rate']
      : ['visitors', 'visits', 'bounce_rate', 'visit_duration'];
  }
  return ['visitors'];
}

/** Map aliases inside raw v2 filter trees (["is", "country", [...]] → "visit:country_name") */
function normalizeRawFilters(filters: unknown[]): unknown[] {
  const operators = new Set<string>(FILTER_OPERATORS);
  const walk = (node: unknown): unknown => {
    if (!Array.isArray(node) || typeof node[0] !== 'string') return node;
    const [head, ...rest] = node;
    if (head === 'and' || head === 'or') return [head, Array.isArray(rest[0]) ? rest[0].map(walk) : rest[0]];
    if (head === 'not' || head === 'has_done' || head === 'has_not_done') return [head, walk(rest[0])];
    if (operators.has(head) && typeof rest[0] === 'string' && rest[0] !== 'segment') {
      return [head, resolveDimension(rest[0]), ...rest.slice(1)];
    }
    return node;
  };
  return filters.map(walk);
}

// =============================================================================
// Tool registration
// =============================================================================

export function registerStatsTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // get_site_overview
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_site_overview',
    {
      title: 'Site overview',
      description:
        'One-call dashboard for a site: key metrics (visitors, visits, pageviews, views per visit, bounce rate, visit duration) ' +
        'with change vs the previous period, plus top pages, sources, countries, devices and goal conversions. ' +
        'Start here for "how is my site doing?" questions.',
      inputSchema: {
        site_id: siteIdParam,
        date_range: dateRangeParam,
        compare: compareParam,
        limit: z.number().int().min(1).max(25).optional().describe('Rows per section (default 5).'),
        filters: filtersParam,
        include_imports: includeImportsParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const dateRange = resolveDateRange(args.date_range, '30d');
      const filters = buildFilters(args.filters);
      const compare = args.compare ?? 'previous_period';
      const limit = args.limit ?? 5;
      const kpiMetrics = filtersMention(filters, 'event:page')
        ? DEFAULT_KPI_METRICS.filter(metric => metric !== 'views_per_visit')
        : DEFAULT_KPI_METRICS;
      const include = buildInclude(args.include_imports, await trimForComparison(ctx, dateRange, compare));
      const base = { site_id: site, date_range: dateRange, filters, include };

      const sections = [
        { key: 'top_pages', title: 'Top pages', dimension: 'event:page', metrics: ['visitors', 'pageviews', 'bounce_rate'] },
        { key: 'top_sources', title: 'Top sources', dimension: 'visit:source', metrics: ['visitors', 'bounce_rate', 'visit_duration'] },
        { key: 'top_countries', title: 'Top countries', dimension: 'visit:country_name', metrics: ['visitors', 'percentage'] },
        { key: 'devices', title: 'Devices', dimension: 'visit:device', metrics: ['visitors', 'percentage'] },
        { key: 'goals', title: 'Goal conversions', dimension: 'event:goal', metrics: ['visitors', 'events', 'conversion_rate'] },
      ];

      const kpiQuery: V2Query = { ...base, metrics: kpiMetrics };
      const kpiPromise = ctx.stats.query(kpiQuery);
      // The comparison only depends on the KPI result — run it alongside the section queries
      const comparisonPromise = compare === 'none'
        ? Promise.resolve(undefined)
        : kpiPromise.then(current => runComparison(ctx, current, kpiQuery, compare, dateRange));
      const [kpiResult, comparisonResult, ...sectionResults] = await Promise.allSettled([
        kpiPromise,
        comparisonPromise,
        ...sections.map(section =>
          ctx.stats.query({
            ...base,
            metrics: section.metrics,
            dimensions: [section.dimension],
            pagination: { limit },
          }),
        ),
      ]);

      if (kpiResult.status === 'rejected') throw kpiResult.reason;
      const current = kpiResult.value;

      const comparison = comparisonResult.status === 'fulfilled' ? comparisonResult.value : undefined;
      const comparisonError = comparisonResult.status === 'rejected'
        ? (comparisonResult.reason instanceof Error ? comparisonResult.reason.message : String(comparisonResult.reason))
        : undefined;

      const kpis = kpiComparison(
        kpiMetrics,
        firstRow(current, kpiMetrics),
        comparison ? firstRow(comparison.response, kpiMetrics) : undefined,
      );

      const sectionData = sections.map((section, index): (typeof section) & { rows: Row[]; error?: string } => {
        const result = sectionResults[index];
        return result.status === 'fulfilled'
          ? { ...section, rows: toRows(result.value, [section.dimension], section.metrics) }
          : { ...section, rows: [], error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
      });

      if (args.format === 'json') {
        return jsonResult({
          site_id: site,
          period: current.query?.date_range,
          comparison_period: comparison?.range,
          filters,
          key_metrics: kpis,
          ...Object.fromEntries(sectionData.map(section => [section.key, section.error ? { error: section.error } : section.rows])),
        });
      }

      const lines = [
        heading('Site overview', site),
        periodLine(current.query?.date_range, comparison?.range),
        ...filterLine(filters),
        ...(comparisonError ? [`Comparison unavailable: ${comparisonError}`] : []),
        '',
        '### Key metrics',
        kpiTable(kpis),
      ];
      for (const section of sectionData) {
        if (section.key === 'goals' && !section.error && section.rows.length === 0) continue;
        lines.push('', `### ${section.title}`);
        lines.push(section.error ? `_Unavailable: ${section.error}_` : markdownTable([dimensionLabel(section.dimension), ...section.metrics], section.rows, section.metrics));
      }
      lines.push(...metaNotes(current, 1).map(note => `\n_${note}_`));
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_aggregate_stats
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_aggregate_stats',
    {
      title: 'Aggregate stats',
      description:
        'Totals for a site over a date range (no breakdown), optionally compared with the previous period or the same ' +
        'period last year. Defaults: last 30 days; visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration.',
      inputSchema: {
        site_id: siteIdParam,
        date_range: dateRangeParam,
        metrics: metricsParam,
        filters: filtersParam,
        compare: compareParam,
        include_imports: includeImportsParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const dateRange = resolveDateRange(args.date_range, '30d');
      const filters = buildFilters(args.filters);
      const compare = args.compare ?? 'none';
      const metrics: string[] = args.metrics
        ?? (filtersMention(filters, 'event:page') ? DEFAULT_KPI_METRICS.filter(m => m !== 'views_per_visit') : DEFAULT_KPI_METRICS);
      const include = buildInclude(args.include_imports, await trimForComparison(ctx, dateRange, compare));

      const query: V2Query = { site_id: site, metrics, date_range: dateRange, filters, include };
      const current = await ctx.stats.query(query);
      const comparison = compare !== 'none' ? await runComparison(ctx, current, query, compare, dateRange) : undefined;
      const kpis = kpiComparison(metrics, firstRow(current, metrics), comparison ? firstRow(comparison.response, metrics) : undefined);

      if (args.format === 'json') {
        return jsonResult({
          site_id: site,
          period: current.query?.date_range,
          comparison_period: comparison?.range,
          filters,
          metrics: kpis,
          meta: current.meta,
        });
      }

      return textResult([
        heading('Aggregate stats', site),
        periodLine(current.query?.date_range, comparison?.range),
        ...filterLine(filters),
        ...(compare !== 'none' && !comparison ? ['_No comparison period exists for this date range._'] : []),
        '',
        kpiTable(kpis),
        ...metaNotes(current, 1).map(note => `\n_${note}_`),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_timeseries
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_timeseries',
    {
      title: 'Timeseries',
      description:
        'Metrics over time, bucketed by hour, day, week or month (auto picks a sensible interval). Empty buckets are filled ' +
        'with zeros. Use for trends, spikes and "traffic per day" questions. Default: last 30 days, visitors + pageviews.',
      inputSchema: {
        site_id: siteIdParam,
        date_range: dateRangeParam,
        metrics: metricsParam,
        interval: z.enum(['auto', 'hour', 'day', 'week', 'month']).optional().describe('Bucket size (default auto).'),
        filters: filtersParam,
        include_imports: includeImportsParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const dateRange = resolveDateRange(args.date_range, '30d');
      const filters = buildFilters(args.filters);
      const metrics: string[] = args.metrics ?? ['visitors', 'pageviews'];
      const interval = args.interval ?? 'auto';
      const timeDimension = interval === 'auto' ? 'time' : `time:${interval}`;

      const response = await ctx.stats.query({
        site_id: site,
        metrics,
        date_range: dateRange,
        dimensions: [timeDimension],
        filters,
        include: buildInclude(args.include_imports, { time_labels: true }),
      });

      const timeColumn = dimensionLabel(timeDimension);
      const rows = zeroFillTimeseries(toRows(response, [timeDimension], metrics), response.meta?.time_labels, timeColumn, metrics);

      if (args.format === 'json') {
        return jsonResult({ site_id: site, period: response.query?.date_range, interval, filters, rows, meta: response.meta });
      }

      const lead = metrics[0];
      const peak = rows.reduce<Row | undefined>((best, row) => {
        const value = Number(row[lead] ?? 0);
        return !best || value > Number(best[lead] ?? 0) ? row : best;
      }, undefined);
      const shown = rows.slice(0, MAX_MARKDOWN_ROWS);

      return textResult([
        heading('Timeseries', site),
        `${periodLine(response.query?.date_range)} · interval: ${interval}`,
        ...filterLine(filters),
        ...(peak && Number(peak[lead] ?? 0) > 0 ? [`Peak ${lead}: ${formatMetricValue(lead, peak[lead])} at ${peak[timeColumn]}`] : []),
        '',
        markdownTable([timeColumn, ...metrics], shown, metrics),
        ...(rows.length > shown.length ? [`\n_Showing the first ${shown.length} of ${rows.length} buckets — use a larger interval or format "json"._`] : []),
        ...metaNotes(response, rows.length).map(note => `\n_${note}_`),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_breakdown
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_breakdown',
    {
      title: 'Breakdown by dimension',
      description:
        'Top values of one or more dimensions with metrics — top pages, entry/exit pages, sources, referrers, channels, ' +
        'UTM tags, countries, regions, cities, devices, browsers, OS, goals or custom properties. Metrics default to ' +
        'sensible ones for the dimension. Supports filters, ordering and pagination.',
      inputSchema: {
        site_id: siteIdParam,
        dimension: z
          .union([z.string(), z.array(z.string()).min(1).max(3)])
          .describe(`Dimension(s) to group by. ${DIMENSION_DESCRIPTION}`),
        date_range: dateRangeParam,
        metrics: metricsParam,
        filters: filtersParam,
        order_by: z
          .object({
            field: z.string().describe('A requested metric or dimension'),
            direction: z.enum(['asc', 'desc']).optional(),
          })
          .optional()
          .describe('Sort order (default: first metric, descending).'),
        limit: z.number().int().min(1).max(1000).optional().describe('Rows to return (default 10).'),
        offset: z.number().int().min(0).optional().describe('Rows to skip, for pagination.'),
        include_imports: includeImportsParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const dateRange = resolveDateRange(args.date_range, '30d');
      const filters = buildFilters(args.filters);
      const dimensions = (Array.isArray(args.dimension) ? args.dimension : [args.dimension]).map(resolveDimension);
      const metrics: string[] = args.metrics ?? defaultBreakdownMetrics(dimensions);
      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;

      let orderBy: V2Query['order_by'];
      if (args.order_by) {
        const field = (METRICS as readonly string[]).includes(args.order_by.field)
          ? args.order_by.field
          : resolveDimension(args.order_by.field);
        orderBy = [[field, args.order_by.direction ?? 'desc']];
      }

      const response = await ctx.stats.query({
        site_id: site,
        metrics,
        date_range: dateRange,
        dimensions,
        filters,
        order_by: orderBy,
        include: buildInclude(args.include_imports, { total_rows: true }),
        pagination: { limit, offset },
      });
      const rows = toRows(response, dimensions, metrics);

      if (args.format === 'json') {
        return jsonResult({ site_id: site, period: response.query?.date_range, dimensions, filters, rows, meta: response.meta });
      }

      const shown = rows.slice(0, MAX_MARKDOWN_ROWS);
      return textResult([
        heading(`Breakdown by ${dimensions.map(dimensionLabel).join(' × ')}`, site),
        periodLine(response.query?.date_range),
        ...filterLine(filters),
        '',
        markdownTable([...dimensions.map(dimensionLabel), ...metrics], shown, metrics),
        ...(rows.length > shown.length ? [`\n_Showing the first ${shown.length} of ${rows.length} rows — use offset or format "json"._`] : []),
        ...metaNotes(response, rows.length, offset).map(note => `\n_${note}_`),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_goal_conversions
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_goal_conversions',
    {
      title: 'Goal conversions',
      description:
        'Conversions for configured goals: unique converting visitors, total conversions (events) and conversion rate. ' +
        'Optionally restrict to specific goals and/or break conversions down by another dimension (e.g. source, page, country) ' +
        '— then group_conversion_rate shows the conversion rate within each group.',
      inputSchema: {
        site_id: siteIdParam,
        date_range: dateRangeParam,
        goals: z.array(z.string()).optional().describe('Goal display names, e.g. ["Signup", "Visit /pricing"]. Default: all goals.'),
        breakdown_by: z.string().optional().describe(`Optional second dimension. ${DIMENSION_DESCRIPTION}`),
        include_revenue: z.boolean().optional().describe('Add total_revenue / average_revenue (Plausible Cloud with revenue goals only).'),
        filters: filtersParam,
        limit: z.number().int().min(1).max(1000).optional().describe('Rows to return (default 20).'),
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const dateRange = resolveDateRange(args.date_range, '30d');
      const filters = buildFilters(args.filters);
      if (args.include_revenue && !ctx.connection.isCloud) {
        throw new ToolInputError('Revenue metrics are only available on Plausible Cloud, not on self-hosted Community Edition.');
      }

      const goals = args.goals?.filter(Boolean) ?? [];
      if (goals.length) filters.push(['is', 'event:goal', goals]);

      const breakdown = args.breakdown_by ? resolveDimension(args.breakdown_by) : undefined;
      const dimensions = breakdown ? (goals.length === 1 ? [breakdown] : ['event:goal', breakdown]) : ['event:goal'];
      const metrics = [
        'visitors',
        // events is an event-only metric: Plausible rejects it with entry/exit page breakdowns
        ...(breakdown && SESSION_ONLY_DIMENSIONS.has(breakdown) ? [] : ['events']),
        breakdown ? 'group_conversion_rate' : 'conversion_rate',
        ...(args.include_revenue ? ['total_revenue', 'average_revenue'] : []),
      ];

      const response = await ctx.stats.query({
        site_id: site,
        metrics,
        date_range: dateRange,
        dimensions,
        filters,
        include: { total_rows: true },
        pagination: { limit: args.limit ?? 20 },
      });
      const rows = toRows(response, dimensions, metrics);

      if (args.format === 'json') {
        return jsonResult({ site_id: site, period: response.query?.date_range, dimensions, filters, rows, meta: response.meta });
      }

      return textResult([
        heading('Goal conversions', site),
        periodLine(response.query?.date_range),
        ...filterLine(filters),
        '',
        rows.length
          ? markdownTable([...dimensions.map(dimensionLabel), ...metrics], rows, metrics)
          : '_No conversions in this period. Goals must be configured in Plausible (Site Settings → Goals) before conversions are counted._',
        '',
        '_visitors = unique converting visitors · events = total conversions_',
        ...metaNotes(response, rows.length).map(note => `\n_${note}_`),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // compare_periods
  // ---------------------------------------------------------------------------
  server.registerTool(
    'compare_periods',
    {
      title: 'Compare periods',
      description:
        'Compare two periods side by side — totals, or the top values of a dimension (e.g. top pages this month vs last ' +
        'month) with absolute values and % change (rates change in percentage points). The Plausible API has no ' +
        'built-in comparison, so this runs both queries and computes the deltas.',
      inputSchema: {
        site_id: siteIdParam,
        date_range: dateRangeParam,
        compare_to: z
          .union([
            z.enum(['previous_period', 'year_over_year']),
            z.object({ from: z.string(), to: z.string() }),
          ])
          .optional()
          .describe('Comparison period: "previous_period" (default), "year_over_year", or a custom {"from","to"} range.'),
        metrics: metricsParam,
        dimension: z.string().optional().describe(`Optional dimension to compare row by row (not a time dimension). ${DIMENSION_DESCRIPTION}`),
        limit: z.number().int().min(1).max(100).optional().describe('Rows when a dimension is given (default 10).'),
        filters: filtersParam,
        include_imports: includeImportsParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const dateRange = resolveDateRange(args.date_range, '30d');
      const filters = buildFilters(args.filters);
      const compareTo = args.compare_to ?? 'previous_period';
      const dimension = args.dimension ? resolveDimension(args.dimension) : undefined;
      if (dimension && isTimeDimension(dimension)) {
        throw new ToolInputError('compare_periods compares rows by value, so time dimensions are not supported — use get_timeseries for each period instead.');
      }

      const metrics: string[] = args.metrics ?? (dimension ? ['visitors'] : ['visitors', 'visits', 'pageviews', 'bounce_rate', 'visit_duration']);
      const include = buildInclude(
        args.include_imports,
        typeof compareTo === 'string' ? await trimForComparison(ctx, dateRange, compareTo) : {},
      );
      const query: V2Query = {
        site_id: site,
        metrics,
        date_range: dateRange,
        filters,
        include,
        ...(dimension ? { dimensions: [dimension], pagination: { limit: args.limit ?? 10 } } : {}),
      };

      const current = await ctx.stats.query(query);
      const currentRows = toRows(current, dimension ? [dimension] : [], metrics);

      // For a dimension, fetch the previous values of exactly the current top rows
      let previousQuery = query;
      if (dimension) {
        const values = currentRows
          .map(row => row[dimensionLabel(dimension)])
          .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
        if (values.length === 0) {
          return textResult(`${heading('Compare periods', site)}\n${periodLine(current.query?.date_range)}\n\n_No data in the current period._`);
        }
        previousQuery = {
          ...query,
          filters: [...filters, ['is', dimension, values]],
          pagination: { limit: values.length },
        };
      }

      const comparison = await runComparison(ctx, current, previousQuery, compareTo, dateRange);
      if (!comparison) {
        throw new ToolInputError('No comparison period exists for this date range (e.g. "all"). Pass compare_to as an explicit {"from","to"} range.');
      }

      if (!dimension) {
        const kpis = kpiComparison(metrics, firstRow(current, metrics), firstRow(comparison.response, metrics));
        if (args.format === 'json') {
          return jsonResult({ site_id: site, period: current.query?.date_range, comparison_period: comparison.range, filters, metrics: kpis });
        }
        return textResult([
          heading('Compare periods', site),
          periodLine(current.query?.date_range, comparison.range),
          ...filterLine(filters),
          '',
          kpiTable(kpis),
        ].join('\n'));
      }

      const label = dimensionLabel(dimension);
      const previousByValue = new Map(
        toRows(comparison.response, [dimension], metrics).map(row => [String(row[label]), row]),
      );
      const merged = currentRows.map(row => {
        const previous = previousByValue.get(String(row[label]));
        const entry: Row = { [label]: row[label] };
        for (const metric of metrics) {
          entry[metric] = row[metric];
          entry[`previous_${metric}`] = previous?.[metric] ?? null;
          entry[`change_${metric}`] = previous ? formatChange(computeChange(metric, row[metric], previous[metric])) : 'new';
        }
        return entry;
      });

      if (args.format === 'json') {
        return jsonResult({ site_id: site, period: current.query?.date_range, comparison_period: comparison.range, dimension, filters, rows: merged });
      }

      const columns = [label, ...metrics.flatMap(metric => [metric, `previous_${metric}`, `change_${metric}`])];
      const formatted = merged.map(row => {
        const out: Row = { [label]: row[label] };
        for (const metric of metrics) {
          out[metric] = formatMetricValue(metric, row[metric]);
          out[`previous_${metric}`] = formatMetricValue(metric, row[`previous_${metric}`]);
          out[`change_${metric}`] = row[`change_${metric}`];
        }
        return out;
      });

      return textResult([
        heading(`Compare periods by ${label}`, site),
        periodLine(current.query?.date_range, comparison.range),
        ...filterLine(filters),
        '',
        markdownTable(columns, formatted, []),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_realtime_visitors
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_realtime_visitors',
    {
      title: 'Realtime visitors',
      description:
        'Visitors on the site right now (last 5 minutes), plus optional recent activity for the last N minutes: ' +
        'visitors, pageviews, top pages and top sources.',
      inputSchema: {
        site_id: siteIdParam,
        minutes: z.number().int().min(5).max(240).optional().describe('Window for recent activity (default 30).'),
        include_breakdown: z.boolean().optional().describe('Include recent top pages / sources (default true).'),
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const minutes = args.minutes ?? 30;
      const now = new Date();
      const toStamp = (date: Date) => `${date.toISOString().slice(0, 19)}+00:00`;
      const window: [string, string] = [toStamp(new Date(now.getTime() - minutes * 60_000)), toStamp(now)];
      const lastFive: [string, string] = [toStamp(new Date(now.getTime() - 5 * 60_000)), toStamp(now)];

      let current: number;
      try {
        current = await ctx.stats.realtimeVisitors(site);
      } catch (error) {
        if (!(error instanceof PlausibleApiError) || error.status !== 404) throw error;
        const fallback = await ctx.stats.query({ site_id: site, metrics: ['visitors'], date_range: lastFive });
        current = Number(fallback.results?.[0]?.metrics?.[0] ?? 0);
      }

      if (args.include_breakdown === false) {
        return args.format === 'json'
          ? jsonResult({ site_id: site, current_visitors: current, timestamp: now.toISOString() })
          : textResult(`**${current}** current visitor${current === 1 ? '' : 's'} on ${site} (last 5 minutes).`);
      }

      const [totals, pages, sources] = await Promise.allSettled([
        ctx.stats.query({ site_id: site, metrics: ['visitors', 'pageviews'], date_range: window }),
        ctx.stats.query({ site_id: site, metrics: ['visitors'], date_range: window, dimensions: ['event:page'], pagination: { limit: 5 } }),
        ctx.stats.query({ site_id: site, metrics: ['visitors'], date_range: window, dimensions: ['visit:source'], pagination: { limit: 5 } }),
      ]);
      const recent = totals.status === 'fulfilled' ? firstRow(totals.value, ['visitors', 'pageviews']) : undefined;
      const pageRows = pages.status === 'fulfilled' ? toRows(pages.value, ['event:page'], ['visitors']) : [];
      const sourceRows = sources.status === 'fulfilled' ? toRows(sources.value, ['visit:source'], ['visitors']) : [];

      if (args.format === 'json') {
        return jsonResult({
          site_id: site,
          current_visitors: current,
          timestamp: now.toISOString(),
          recent: { minutes, ...recent, top_pages: pageRows, top_sources: sourceRows },
        });
      }

      return textResult([
        heading('Realtime', site),
        `**${current}** current visitor${current === 1 ? '' : 's'} (last 5 minutes)`,
        recent ? `Last ${minutes} minutes: ${formatMetricValue('visitors', recent.visitors)} visitors, ${formatMetricValue('pageviews', recent.pageviews)} pageviews` : '',
        '',
        `### Top pages (last ${minutes} min)`,
        markdownTable(['page', 'visitors'], pageRows, ['visitors']),
        '',
        `### Top sources (last ${minutes} min)`,
        markdownTable(['source', 'visitors'], sourceRows, ['visitors']),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // query_stats — raw Stats API v2 escape hatch
  // ---------------------------------------------------------------------------
  server.registerTool(
    'query_stats',
    {
      title: 'Raw Stats API v2 query',
      description:
        'Full Plausible Stats API v2 query for anything the other tools do not cover: multiple dimensions, nested ' +
        'and/or/not filters, behavioral has_done / has_not_done filters, segments, custom ordering and pagination. ' +
        'Results are returned as named rows. Docs: https://plausible.io/docs/stats-api',
      inputSchema: {
        site_id: siteIdParam,
        metrics: z.array(z.enum(METRICS)).min(1).describe(`Metrics. ${'See get_instance_info for what this instance supports.'}`),
        date_range: z
          .union([z.string(), z.array(z.string()).length(2), z.object({ from: z.string(), to: z.string() })])
          .optional()
          .describe('Shorthand ("30d", "month", …), ["2026-01-01","2026-01-31"], or {"from","to"}. Default "30d".'),
        dimensions: z.array(z.string()).optional().describe(`Dimensions. ${DIMENSION_DESCRIPTION}`),
        filters: z
          .array(z.any())
          .optional()
          .describe(
            'Raw v2 filters. Simple: ["is", "visit:country_name", ["Germany"]]. Operators: is, is_not, contains, contains_not, ' +
            'matches, matches_not; optional 4th element {"case_sensitive": false}. Logical: ["and", [f1, f2]], ["or", [...]], ' +
            '["not", f]. Behavioral: ["has_done", ["is", "event:goal", ["Signup"]]]. Segment: ["is", "segment", [123]]. ' +
            'Dimension aliases (country, page, source…) are accepted.',
          ),
        order_by: z
          .array(z.array(z.string()).length(2))
          .optional()
          .describe('e.g. [["visitors", "desc"], ["event:page", "asc"]]'),
        include: z
          .object({
            imports: z.boolean().optional(),
            time_labels: z.boolean().optional(),
            total_rows: z.boolean().optional(),
            trim_relative_date_range: z.boolean().optional().describe('CE 3.1+'),
          })
          .optional(),
        pagination: z
          .object({
            limit: z.number().int().min(1).max(10000).optional(),
            offset: z.number().int().min(0).optional(),
          })
          .optional(),
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(ctx, async () => {
      const site = resolveSite(ctx, args.site_id);
      const dateRange = resolveDateRange(args.date_range as string | string[] | { from: string; to: string } | undefined, '30d');
      const dimensions = (args.dimensions ?? []).map(resolveDimension);
      const metrics = args.metrics as string[];
      const filters = normalizeRawFilters(args.filters ?? []);

      const orderBy = args.order_by?.map(([field, direction]) => {
        const dir = direction.toLowerCase();
        if (dir !== 'asc' && dir !== 'desc') throw new ToolInputError(`order_by direction must be "asc" or "desc" (got "${direction}").`);
        const resolved = (METRICS as readonly string[]).includes(field) ? field : resolveDimension(field);
        return [resolved, dir] as [string, 'asc' | 'desc'];
      });

      const include: Record<string, boolean> = Object.fromEntries(
        Object.entries(args.include ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      );
      const response = await ctx.stats.query({
        site_id: site,
        metrics,
        date_range: dateRange,
        dimensions,
        filters,
        order_by: orderBy,
        include,
        pagination: args.pagination,
      });
      const rows = toRows(response, dimensions, metrics);

      if (args.format === 'json') {
        return jsonResult({ rows, meta: response.meta, query: response.query });
      }

      const shown = rows.slice(0, MAX_MARKDOWN_ROWS);
      return textResult([
        heading('Stats query', site),
        periodLine(response.query?.date_range),
        ...filterLine(filters),
        '',
        markdownTable([...dimensions.map(dimensionLabel), ...metrics], shown, metrics),
        ...(rows.length > shown.length ? [`\n_Showing the first ${shown.length} of ${rows.length} rows — use pagination or format "json"._`] : []),
        ...metaNotes(response, rows.length, args.pagination?.offset ?? 0).map(note => `\n_${note}_`),
      ].join('\n'));
    }),
  );
}

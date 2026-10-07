/**
 * Output formatting: Plausible's positional result arrays → named rows, compact
 * markdown tables for LLM consumption, and actionable hints for API errors.
 */

import type { V2QueryResponse } from './client.js';
import { PlausibleApiError } from './http.js';
import { describeInstance, type InstanceProfile, versionAtLeast } from './profile.js';
import {
  type Change,
  DIMENSION_DESCRIPTION,
  DURATION_METRICS,
  RATE_METRICS,
  REVENUE_METRICS,
  dimensionLabel,
  numericValue,
} from './query-helpers.js';

export type Row = Record<string, unknown>;

const MAX_CELL_LENGTH = 120;

// =============================================================================
// Rows
// =============================================================================

export function toRows(response: V2QueryResponse, dimensions: string[], metrics: string[]): Row[] {
  return (response.results ?? []).map(result => {
    const row: Row = {};
    dimensions.forEach((dimension, index) => {
      row[dimensionLabel(dimension)] = result.dimensions?.[index] ?? null;
    });
    metrics.forEach((metric, index) => {
      row[metric] = result.metrics?.[index] ?? null;
    });
    return row;
  });
}

/** Insert zero rows for empty time buckets using meta.time_labels */
export function zeroFillTimeseries(rows: Row[], timeLabels: string[] | undefined, timeColumn: string, metrics: string[]): Row[] {
  if (!timeLabels?.length) return rows;
  const byLabel = new Map(rows.map(row => [String(row[timeColumn]), row]));
  if (![...byLabel.keys()].every(label => timeLabels.includes(label))) return rows; // formats differ — leave as-is

  return timeLabels.map(label => {
    const existing = byLabel.get(label);
    if (existing) return existing;
    const empty: Row = { [timeColumn]: label };
    for (const metric of metrics) empty[metric] = REVENUE_METRICS.has(metric) ? null : 0;
    return empty;
  });
}

// =============================================================================
// Values
// =============================================================================

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${rest}s`;
}

export function formatMetricValue(metric: string, value: unknown): string {
  if (value === null || value === undefined) return '—';

  if (REVENUE_METRICS.has(metric) && typeof value === 'object') {
    const revenue = value as { short?: string; long?: string; value?: number; currency?: string };
    return revenue.short ?? revenue.long ?? `${revenue.value ?? ''} ${revenue.currency ?? ''}`.trim();
  }

  const number = numericValue(value);
  if (number === null) return String(value);
  if (RATE_METRICS.has(metric)) return `${formatNumber(number)}%`;
  if (DURATION_METRICS.has(metric)) return formatDuration(number);
  return formatNumber(number);
}

export function formatChange(change: Change): string {
  if (change.value === null) return 'n/a';
  const sign = change.value > 0 ? '+' : '';
  return `${sign}${formatNumber(change.value)}${change.unit === 'pp' ? ' pp' : '%'}`;
}

function formatCell(column: string, value: unknown, metricColumns: Set<string>): string {
  const text = metricColumns.has(column)
    ? formatMetricValue(column, value)
    : value === null || value === undefined || value === ''
      ? '(none)'
      : String(value);
  const flat = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return flat.length > MAX_CELL_LENGTH ? `${flat.slice(0, MAX_CELL_LENGTH - 1)}…` : flat;
}

export function markdownTable(columns: string[], rows: Row[], metricColumns: Iterable<string>): string {
  if (rows.length === 0) return '_No data for this period._';
  const metrics = new Set(metricColumns);
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(column => (metrics.has(column) ? '---:' : '---')).join(' | ')} |`;
  const body = rows.map(row => `| ${columns.map(column => formatCell(column, row[column], metrics)).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

// =============================================================================
// Context lines
// =============================================================================

/** "2026-09-08 → 2026-10-07" (times shown only for partial days) */
export function describePeriod(range: [string, string] | undefined): string {
  if (!range) return 'unknown period';
  const [start, end] = range;
  const wholeDays = /T00:00:00/.test(start) && /T23:59:59/.test(end);
  const clean = (value: string) => (wholeDays ? value.slice(0, 10) : value.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?(?=[Z+-]|$)/, ''));
  const startText = clean(start);
  const endText = clean(end);
  return startText === endText ? startText : `${startText} → ${endText}`;
}

export function describeFilters(filters: unknown[] | undefined): string | undefined {
  if (!filters?.length) return undefined;
  return filters
    .map(filter => {
      if (!Array.isArray(filter)) return JSON.stringify(filter);
      const [operator, dimension, values] = filter;
      if (typeof dimension === 'string' && Array.isArray(values)) {
        return `${dimensionLabel(dimension)} ${operator} ${values.map(value => JSON.stringify(value)).join(' | ')}`;
      }
      return JSON.stringify(filter);
    })
    .join('; ');
}

export function metaNotes(response: V2QueryResponse, shownRows: number, offset = 0): string[] {
  const notes: string[] = [];
  const meta = response.meta ?? {};

  if (typeof meta.total_rows === 'number' && meta.total_rows > offset + shownRows) {
    notes.push(`Showing rows ${offset + 1}–${offset + shownRows} of ${meta.total_rows}. Call again with offset=${offset + shownRows} for more.`);
  }
  if (meta.imports_warning) notes.push(`Imports: ${meta.imports_warning}`);
  if (meta.imports_skip_reason) notes.push(`Imported data not included (${meta.imports_skip_reason}).`);
  for (const [metric, warning] of Object.entries(meta.metric_warnings ?? {})) {
    notes.push(`${metric}: ${warning.warning ?? warning.message ?? warning.code}`);
  }
  return notes;
}

// =============================================================================
// Error hints
// =============================================================================

const HINTS: Array<{ test: RegExp; hint: (profile?: InstanceProfile) => string }> = [
  {
    test: /views_per_visit/i,
    hint: () => 'views_per_visit cannot be combined with dimensions or a page filter on this Plausible version — drop it, or use visits and pageviews instead.',
  },
  {
    test: /conversion_rate.*goal|goal.*conversion_rate/i,
    hint: () => 'conversion_rate / group_conversion_rate need a goal filter or the "goal" dimension — use get_goal_conversions.',
  },
  {
    test: /total_revenue|average_revenue/i,
    hint: profile => profile?.edition === 'community'
      ? 'Revenue metrics are not available on self-hosted Community Edition.'
      : 'Revenue metrics need revenue goals and a goal filter or goal dimension.',
  },
  {
    test: /scroll_depth/i,
    hint: profile => versionAtLeast(profile, [3, 0, 0]) === false
      ? `scroll_depth needs Plausible CE 3.0 or newer (this is ${describeInstance(profile)}).`
      : 'scroll_depth needs a page dimension or a page filter.',
  },
  {
    test: /time_on_page/i,
    hint: profile => versionAtLeast(profile, [3, 0, 0]) === false
      ? `time_on_page needs Plausible CE 3.0 or newer (this is ${describeInstance(profile)}).`
      : 'time_on_page needs a page dimension or a page filter.',
  },
  {
    test: /percentage/i,
    hint: () => 'percentage needs at least one dimension.',
  },
  {
    test: /goal `?(.+?)`? is not configured|is not configured for this site/i,
    hint: () => 'That goal does not exist on this site. Use list_goals (if available) or get_breakdown with dimension "goal" to see configured goals.',
  },
  {
    test: /session (?:dimensions|metrics)|event (?:dimensions|metrics)|cannot be queried with/i,
    hint: () => 'Session metrics (bounce_rate, visit_duration, views_per_visit) cannot be mixed with event dimensions other than page, and pageviews cannot be used with entry/exit page dimensions. Split the query or change metrics.',
  },
  {
    test: /Invalid date.?range|date_range/i,
    hint: profile => versionAtLeast(profile, [3, 0, 0]) === false
      ? `Ranges like 28d, 91d and <N>d / <N>mo need Plausible CE 3.0+ (this is ${describeInstance(profile)}). Use 7d, 30d, month, 6mo, 12mo, year, all or explicit dates.`
      : 'Check the date_range value (e.g. "30d", "month", or {"from":"2026-01-01","to":"2026-01-31"}). "24h" is Plausible Cloud only.',
  },
  {
    test: /Invalid dimension/i,
    hint: () => DIMENSION_DESCRIPTION,
  },
  {
    test: /segment/i,
    hint: () => 'Segment filters need CE 3.0+; segment IDs come from the dashboard URL. There is no public API to list segments.',
  },
  {
    test: /has_done|has_not_done|behavioral/i,
    hint: () => 'has_done / has_not_done filters may only contain event dimensions (page, goal, event:name, props) and cannot be nested.',
  },
  {
    test: /Invalid filter|filter/i,
    hint: () => 'Filters look like ["is", "visit:country_name", ["Germany"]]; "is_not", "contains_not" and "matches*" cannot be used with goal filters, and goal/hostname filters must be top-level.',
  },
];

export function hintForError(error: PlausibleApiError, profile?: InstanceProfile): string | undefined {
  if (error.status === 0) {
    return 'Could not reach the Plausible instance. Check the instance URL and that it is publicly reachable from this server.';
  }
  if (error.status === 401) {
    return error.endpoint.includes('/api/plugins/')
      ? 'The plugin token was rejected. Plugin tokens are per site — create one under Site Settings → Integrations → Plugin Tokens.'
      : 'The API key was rejected, or it cannot access this site. Keys only see sites owned by the team they were created in (Account Settings → API Keys).';
  }
  if (error.status === 402) {
    return 'Plausible says this feature is not included in the current plan (Stats API needs Business; Sites API needs Enterprise on Plausible Cloud).';
  }
  if (error.status === 404 && error.endpoint.includes('/api/v1/sites')) {
    return 'The Sites API does not exist on self-hosted Community Edition. Configure your site domains on the connection instead.';
  }
  if (error.status === 404) {
    return `Endpoint not found on ${describeInstance(profile)} — the instance may be too old for this feature.`;
  }
  if (error.status === 429) {
    return 'Rate limit reached (Plausible Cloud allows 600 API requests per hour per key). Wait and retry, or use fewer queries.';
  }
  if (error.status === 400 || error.status === 422) {
    const match = HINTS.find(({ test }) => test.test(error.message));
    return match?.hint(profile) ?? 'Use get_instance_info to see which metrics and ranges this instance supports.';
  }
  return undefined;
}

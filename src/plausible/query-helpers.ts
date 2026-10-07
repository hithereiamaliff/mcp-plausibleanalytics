/**
 * Stats API v2 query helpers: metric / dimension vocabularies, friendly aliases,
 * filter building, date-range validation and comparison-period maths.
 *
 * Pure functions only — unit-tested in test/query-helpers.test.ts.
 */

import type { DateRange } from './client.js';

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

// =============================================================================
// Metrics
// =============================================================================

export const METRICS = [
  'visitors',
  'visits',
  'pageviews',
  'views_per_visit',
  'bounce_rate',
  'visit_duration',
  'events',
  'scroll_depth',
  'time_on_page',
  'percentage',
  'conversion_rate',
  'group_conversion_rate',
  'total_revenue',
  'average_revenue',
] as const;

export type Metric = (typeof METRICS)[number];

/** Metrics expressed as a percentage — changes are reported in percentage points */
export const RATE_METRICS = new Set<string>(['bounce_rate', 'conversion_rate', 'group_conversion_rate', 'percentage', 'scroll_depth']);
export const DURATION_METRICS = new Set<string>(['visit_duration', 'time_on_page']);
export const REVENUE_METRICS = new Set<string>(['total_revenue', 'average_revenue']);

export const METRICS_DESCRIPTION =
  'visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration, events, ' +
  'scroll_depth (needs page), time_on_page (needs page), percentage (needs a dimension), ' +
  'conversion_rate / group_conversion_rate (need a goal filter or goal dimension), ' +
  'total_revenue / average_revenue (Plausible Cloud only)';

// =============================================================================
// Dimensions
// =============================================================================

export const EVENT_DIMENSIONS = ['event:page', 'event:hostname', 'event:goal', 'event:name'];
export const VISIT_DIMENSIONS = [
  'visit:entry_page', 'visit:exit_page', 'visit:entry_page_hostname', 'visit:exit_page_hostname',
  'visit:source', 'visit:referrer', 'visit:channel',
  'visit:utm_source', 'visit:utm_medium', 'visit:utm_campaign', 'visit:utm_content', 'visit:utm_term',
  'visit:device', 'visit:browser', 'visit:browser_version', 'visit:os', 'visit:os_version',
  'visit:country', 'visit:region', 'visit:city', 'visit:country_name', 'visit:region_name', 'visit:city_name',
];
export const TIME_DIMENSIONS = ['time', 'time:hour', 'time:day', 'time:week', 'time:month'];

/** Session-only dimensions: cannot be combined with event-only metrics (pageviews, events, …) */
export const SESSION_ONLY_DIMENSIONS = new Set([
  'visit:entry_page', 'visit:exit_page', 'visit:entry_page_hostname', 'visit:exit_page_hostname',
]);

/** Short, LLM-friendly names → Plausible dimension names */
export const DIMENSION_ALIASES: Record<string, string> = {
  page: 'event:page',
  hostname: 'event:hostname',
  goal: 'event:goal',
  event_name: 'event:name',
  entry_page: 'visit:entry_page',
  exit_page: 'visit:exit_page',
  entry_page_hostname: 'visit:entry_page_hostname',
  exit_page_hostname: 'visit:exit_page_hostname',
  source: 'visit:source',
  referrer: 'visit:referrer',
  channel: 'visit:channel',
  utm_source: 'visit:utm_source',
  utm_medium: 'visit:utm_medium',
  utm_campaign: 'visit:utm_campaign',
  utm_content: 'visit:utm_content',
  utm_term: 'visit:utm_term',
  device: 'visit:device',
  browser: 'visit:browser',
  browser_version: 'visit:browser_version',
  os: 'visit:os',
  os_version: 'visit:os_version',
  country: 'visit:country_name',
  region: 'visit:region_name',
  city: 'visit:city_name',
  country_code: 'visit:country',
  region_code: 'visit:region',
  city_id: 'visit:city',
};

const LABEL_OVERRIDES: Record<string, string> = Object.fromEntries(
  Object.entries(DIMENSION_ALIASES).map(([alias, dimension]) => [dimension, alias]),
);

export const DIMENSION_DESCRIPTION =
  'Alias or full name. Aliases: page, entry_page, exit_page, hostname, source, referrer, channel, ' +
  'utm_source, utm_medium, utm_campaign, utm_content, utm_term, device, browser, browser_version, os, ' +
  'os_version, country, region, city, country_code, goal, event_name, prop:<custom property>. ' +
  'Full names like "visit:country_name", "event:props:author" or "time:day" also work.';

export function resolveDimension(input: string): string {
  const value = input.trim();
  const lower = value.toLowerCase();

  if (Object.hasOwn(DIMENSION_ALIASES, lower)) return DIMENSION_ALIASES[lower];

  const prop = /^(?:prop|props|event:props):(.+)$/i.exec(value);
  if (prop) return `event:props:${prop[1].trim()}`;

  if (TIME_DIMENSIONS.includes(lower)) return lower;
  if (EVENT_DIMENSIONS.includes(lower) || VISIT_DIMENSIONS.includes(lower)) return lower;

  throw new ToolInputError(`Unknown dimension "${input}". ${DIMENSION_DESCRIPTION}`);
}

/** Column label for a dimension: short alias where one exists */
export function dimensionLabel(dimension: string): string {
  if (Object.hasOwn(LABEL_OVERRIDES, dimension)) return LABEL_OVERRIDES[dimension];
  if (dimension.startsWith('event:props:')) return `prop:${dimension.slice('event:props:'.length)}`;
  return dimension;
}

export function isTimeDimension(dimension: string): boolean {
  return dimension === 'time' || dimension.startsWith('time:');
}

// =============================================================================
// Filters
// =============================================================================

export const FILTER_OPERATORS = ['is', 'is_not', 'contains', 'contains_not', 'matches', 'matches_not'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FriendlyFilter {
  dimension: string;
  operator?: FilterOperator;
  values: Array<string | number>;
  case_sensitive?: boolean;
}

export function buildFilters(filters: FriendlyFilter[] | undefined): unknown[] {
  if (!filters?.length) return [];

  return filters.map(filter => {
    const dimension = resolveDimension(filter.dimension);
    const operator = filter.operator ?? 'is';

    if (isTimeDimension(dimension)) {
      throw new ToolInputError('Time dimensions cannot be used in filters — use date_range instead.');
    }
    if (dimension === 'event:goal' && !['is', 'contains'].includes(operator)) {
      throw new ToolInputError('Goal filters only support the "is" and "contains" operators.');
    }
    if (!filter.values?.length) {
      throw new ToolInputError(`Filter on "${filter.dimension}" needs at least one value.`);
    }

    const tuple: unknown[] = [operator, dimension, filter.values];
    if (filter.case_sensitive === false) {
      if (operator === 'matches' || operator === 'matches_not') {
        throw new ToolInputError('case_sensitive cannot be combined with the matches / matches_not operators (use a (?i) regex instead).');
      }
      tuple.push({ case_sensitive: false });
    }
    return tuple;
  });
}

export function filtersMention(filters: unknown[] | undefined, dimension: string): boolean {
  return JSON.stringify(filters ?? []).includes(`"${dimension}"`);
}

// =============================================================================
// Date ranges
// =============================================================================

export type DateRangeInput = string | { from: string; to: string } | string[];

const SHORTHAND_ALIASES: Record<string, string> = {
  today: 'day',
  this_month: 'month',
  this_year: 'year',
  all_time: 'all',
  last_24h: '24h',
  last_24_hours: '24h',
};

const NAMED_RANGES = new Set(['day', 'month', 'year', 'all', '24h']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const DATE_RANGE_DESCRIPTION =
  'Shorthand: "day" (today), "7d", "28d", "30d", "91d", "month" (this month), "6mo", "12mo", "year" (this year), ' +
  '"all", any "<N>d" / "<N>mo", or "24h" (Cloud only). Or a custom range {"from": "2026-01-01", "to": "2026-01-31"} ' +
  '(dates are inclusive, in the site timezone; ISO datetimes with offset are also accepted).';

export function resolveDateRange(input: DateRangeInput | undefined, fallback: DateRange = '30d'): DateRange {
  if (input === undefined || input === null || input === '') return fallback;

  if (typeof input === 'string') {
    const value = input.trim().toLowerCase();
    const normalized = Object.hasOwn(SHORTHAND_ALIASES, value) ? SHORTHAND_ALIASES[value] : value;
    if (normalized === 'realtime') {
      throw new ToolInputError('There is no "realtime" date range in the Stats API — use get_realtime_visitors instead.');
    }
    if (NAMED_RANGES.has(normalized) || /^\d+d$/.test(normalized) || /^\d+mo$/.test(normalized)) {
      return normalized;
    }
    throw new ToolInputError(`Invalid date_range "${input}". ${DATE_RANGE_DESCRIPTION}`);
  }

  const [from, to] = Array.isArray(input) ? input : [input.from, input.to];
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new ToolInputError(`Custom date_range needs both "from" and "to". ${DATE_RANGE_DESCRIPTION}`);
  }

  const start = from.trim();
  const end = to.trim();
  const bothDates = DATE_ONLY.test(start) && DATE_ONLY.test(end);
  const bothDateTimes = DATE_TIME.test(start) && DATE_TIME.test(end);

  if (!bothDates && !bothDateTimes) {
    throw new ToolInputError(
      'Custom date_range must be two dates (YYYY-MM-DD) or two ISO datetimes with offset (e.g. 2026-01-01T09:00:00+08:00).',
    );
  }
  if (bothDates && start > end) {
    throw new ToolInputError(`date_range "from" (${start}) is after "to" (${end}).`);
  }

  const withSeconds = (value: string) => value.replace(/T(\d{2}:\d{2})(Z|[+-])/, 'T$1:00$2');
  return bothDates ? [start, end] : [withSeconds(start), withSeconds(end)];
}

// =============================================================================
// Comparison periods
// =============================================================================

export type CompareMode = 'previous_period' | 'year_over_year';

interface Stamp {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
  offset: string; // "", "Z", "+08:00"
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function parseStamp(value: string): Stamp | undefined {
  const match = STAMP.exec(value.trim());
  if (!match) return undefined;
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    hh: Number(match[4] ?? 0),
    mm: Number(match[5] ?? 0),
    ss: Number(match[6] ?? 0),
    offset: match[7] ?? '',
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function offsetMinutes(offset: string): number {
  if (!offset || offset === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function stampToEpoch(stamp: Stamp): number {
  return Date.UTC(stamp.y, stamp.m - 1, stamp.d, stamp.hh, stamp.mm, stamp.ss) - offsetMinutes(stamp.offset) * 60_000;
}

function epochToStamp(epoch: number, offset: string): Stamp {
  const local = new Date(epoch + offsetMinutes(offset) * 60_000);
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    hh: local.getUTCHours(),
    mm: local.getUTCMinutes(),
    ss: local.getUTCSeconds(),
    offset,
  };
}

function formatDate(stamp: Stamp): string {
  return `${pad(stamp.y, 4)}-${pad(stamp.m)}-${pad(stamp.d)}`;
}

function formatDateTime(stamp: Stamp): string {
  const offset = stamp.offset === 'Z' || stamp.offset === '' ? '+00:00' : stamp.offset;
  return `${formatDate(stamp)}T${pad(stamp.hh)}:${pad(stamp.mm)}:${pad(stamp.ss)}${offset}`;
}

/** Shift a wall-clock stamp by calendar units (months clamp to the end of month) */
function shiftCalendar(stamp: Stamp, months: number, days: number, keepMonthEnd: boolean): Stamp {
  const isMonthEnd = stamp.d === daysInMonth(stamp.y, stamp.m);
  const totalMonths = stamp.y * 12 + (stamp.m - 1) + months;
  const y = Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;
  const d = keepMonthEnd && isMonthEnd ? daysInMonth(y, m) : Math.min(stamp.d, daysInMonth(y, m));

  const shifted = new Date(Date.UTC(y, m - 1, d + days, stamp.hh, stamp.mm, stamp.ss));
  return {
    ...stamp,
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

function isStartOfDay(stamp: Stamp): boolean {
  return stamp.hh === 0 && stamp.mm === 0 && stamp.ss === 0;
}

function isEndOfDay(stamp: Stamp): boolean {
  return stamp.hh === 23 && stamp.mm === 59 && stamp.ss === 59;
}

function dayDiff(start: Stamp, end: Stamp): number {
  return Math.round((Date.UTC(end.y, end.m - 1, end.d) - Date.UTC(start.y, start.m - 1, start.d)) / 86_400_000);
}

/**
 * Compute the comparison range for a query, given the absolute range Plausible resolved
 * (`query.date_range` in the v2 response) and the range the caller originally asked for.
 *
 * Returns undefined when no meaningful comparison exists (e.g. "all").
 */
export function comparisonRange(
  resolved: [string, string],
  mode: CompareMode,
  original: DateRange,
): [string, string] | undefined {
  const start = parseStamp(resolved[0]);
  const end = parseStamp(resolved[1]);
  if (!start || !end) return undefined;

  const shorthand = typeof original === 'string' ? original : undefined;
  if (shorthand === 'all') return undefined;

  const wholeDays = isStartOfDay(start) && (isEndOfDay(end) || resolved[1].length === 10);
  const output = (s: Stamp, e: Stamp): [string, string] =>
    wholeDays ? [formatDate(s), formatDate(e)] : [formatDateTime(s), formatDateTime(e)];

  if (mode === 'year_over_year') {
    return output(shiftCalendar(start, -12, 0, false), shiftCalendar(end, -12, 0, wholeDays));
  }

  // previous_period
  if (shorthand === '24h' || (!wholeDays && !shorthand)) {
    const startMs = stampToEpoch(start);
    const endMs = stampToEpoch(end);
    const duration = endMs - startMs + 1000;
    return output(epochToStamp(startMs - duration, start.offset), epochToStamp(startMs - 1000, start.offset));
  }

  if (shorthand === 'day') {
    return output(shiftCalendar(start, 0, -1, false), shiftCalendar(end, 0, -1, false));
  }
  if (shorthand === 'year') {
    return output(shiftCalendar(start, -12, 0, false), shiftCalendar(end, -12, 0, wholeDays));
  }

  const monthShorthand = shorthand === 'month' ? 1 : shorthand && /^\d+mo$/.test(shorthand) ? parseInt(shorthand, 10) : 0;
  const spansWholeMonths = start.d === 1 && wholeDays && end.d === daysInMonth(end.y, end.m);

  if (monthShorthand || spansWholeMonths) {
    const months = monthShorthand || (end.y * 12 + end.m) - (start.y * 12 + start.m) + 1;
    return output(shiftCalendar(start, -months, 0, false), shiftCalendar(end, -months, 0, wholeDays));
  }

  // Day-based ranges: Nd shorthands and custom whole-day ranges
  const days = dayDiff(start, end) + 1;
  return output(shiftCalendar(start, 0, -days, false), shiftCalendar(end, 0, -days, false));
}

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/;

/** UTC offset suffix of an ISO datetime ("+08:00", "Z"), if any */
export function offsetOf(stamp: string): string | undefined {
  return OFFSET_SUFFIX.exec(stamp)?.[1];
}

/** Replace the UTC offsets of a datetime range (used to apply the site's DST-correct offsets) */
export function withOffsets(range: [string, string], startOffset?: string, endOffset?: string): [string, string] {
  const swap = (stamp: string, offset?: string) =>
    offset ? stamp.replace(OFFSET_SUFFIX, offset === 'Z' ? '+00:00' : offset) : stamp;
  return [swap(range[0], startOffset), swap(range[1], endOffset)];
}

// =============================================================================
// Change calculation
// =============================================================================

export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === 'number' ? inner : Number(inner);
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export interface Change {
  /** percent change, or percentage-point difference for rate metrics */
  value: number | null;
  unit: '%' | 'pp';
}

export function computeChange(metric: string, current: unknown, previous: unknown): Change {
  const unit = RATE_METRICS.has(metric) ? 'pp' : '%';
  const now = numericValue(current);
  const before = numericValue(previous);
  if (now === null || before === null) return { value: null, unit };

  if (unit === 'pp') return { value: Math.round((now - before) * 10) / 10, unit };
  if (before === 0) return { value: null, unit };
  return { value: Math.round(((now - before) / before) * 1000) / 10, unit };
}

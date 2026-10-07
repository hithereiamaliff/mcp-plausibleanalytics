/**
 * Plausible Stats API (v2 + legacy v1 realtime), Events API and instance endpoints.
 * Everything here is available on both self-hosted Community Edition and Plausible Cloud.
 */

import { plausibleRequest } from './http.js';

export type DateRange = string | [string, string];

export interface V2Query {
  site_id: string;
  metrics: string[];
  date_range: DateRange;
  dimensions?: string[];
  filters?: unknown[];
  order_by?: Array<[string, 'asc' | 'desc']>;
  include?: Record<string, boolean>;
  pagination?: { limit?: number; offset?: number };
}

export interface V2Row {
  metrics: unknown[];
  dimensions: unknown[];
}

export interface V2QueryResponse {
  results: V2Row[];
  meta: Record<string, unknown> & {
    time_labels?: string[];
    total_rows?: number;
    imports_included?: boolean;
    imports_skip_reason?: string;
    imports_warning?: string;
    metric_warnings?: Record<string, { code?: string; warning?: string; message?: string }>;
  };
  /** The query as Plausible normalised it; date_range is resolved to absolute timestamps */
  query: Omit<V2Query, 'date_range'> & { date_range: [string, string] };
}

export interface SystemInfo {
  build?: { version?: string | null; commit?: string | null; created?: string | null; tags?: string | null };
  geo_database?: string;
}

export interface PlausibleEvent {
  domain: string;
  name: string;
  url: string;
  referrer?: string;
  props?: Record<string, string | number | boolean>;
  revenue?: { currency: string; amount: string | number };
  interactive?: boolean;
}

export class PlausibleClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private get auth() {
    return { type: 'bearer' as const, token: this.apiKey };
  }

  // ---------------------------------------------------------------------------
  // Stats API v2 — POST /api/v2/query
  // ---------------------------------------------------------------------------

  async query(query: V2Query): Promise<V2QueryResponse> {
    const body: Record<string, unknown> = {
      site_id: query.site_id,
      metrics: query.metrics,
      date_range: query.date_range,
    };
    if (query.dimensions?.length) body.dimensions = query.dimensions;
    if (query.filters?.length) body.filters = query.filters;
    if (query.order_by?.length) body.order_by = query.order_by;
    if (query.include && Object.keys(query.include).length > 0) body.include = query.include;
    if (query.pagination) body.pagination = query.pagination;

    const { data } = await plausibleRequest<V2QueryResponse>(this.baseUrl, '/api/v2/query', {
      method: 'POST',
      body,
      auth: this.auth,
    });
    return data;
  }

  // ---------------------------------------------------------------------------
  // Stats API v1 (legacy) — the only first-class realtime endpoint
  // ---------------------------------------------------------------------------

  async realtimeVisitors(siteId: string): Promise<number> {
    const { data } = await plausibleRequest<unknown>(this.baseUrl, '/api/v1/stats/realtime/visitors', {
      query: { site_id: siteId },
      auth: this.auth,
    });
    const count = typeof data === 'number' ? data : Number(data);
    return Number.isFinite(count) ? count : 0;
  }

  // ---------------------------------------------------------------------------
  // Instance endpoints (no auth)
  // ---------------------------------------------------------------------------

  async systemInfo(): Promise<SystemInfo> {
    const { data } = await plausibleRequest<SystemInfo>(this.baseUrl, '/api/system', {
      auth: { type: 'none' },
      timeoutMs: 8000,
    });
    return data ?? {};
  }

  async healthReady(): Promise<Record<string, unknown>> {
    const { data } = await plausibleRequest<Record<string, unknown>>(this.baseUrl, '/api/system/health/ready', {
      auth: { type: 'none' },
      timeoutMs: 8000,
    });
    return data ?? {};
  }

  async querySchema(): Promise<Record<string, unknown>> {
    const { data } = await plausibleRequest<Record<string, unknown>>(this.baseUrl, '/api/docs/query/schema.json', {
      auth: { type: 'none' },
      timeoutMs: 8000,
    });
    return data ?? {};
  }

  // ---------------------------------------------------------------------------
  // Events API — POST /api/event (no auth; identified by domain)
  // ---------------------------------------------------------------------------

  async sendEvent(
    event: PlausibleEvent,
    client: { userAgent: string; ip?: string },
  ): Promise<{ status: number; dropped: number }> {
    const headers: Record<string, string> = { 'User-Agent': client.userAgent };
    if (client.ip) headers['X-Forwarded-For'] = client.ip;

    const { status, headers: responseHeaders } = await plausibleRequest(this.baseUrl, '/api/event', {
      method: 'POST',
      body: event,
      auth: { type: 'none' },
      headers,
    });
    const dropped = Number(responseHeaders.get('x-plausible-dropped') || 0);
    return { status, dropped: Number.isFinite(dropped) ? dropped : 0 };
  }
}

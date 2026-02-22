/**
 * Plausible Analytics API Client
 * Handles all communication with Plausible's Stats API v2, Events API, and Sites API v1
 */

export interface PlausibleConfig {
  apiUrl: string;
  apiKey: string;
}

export class PlausibleClient {
  private apiUrl: string;
  private apiKey: string;

  constructor(config: PlausibleConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.apiUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Plausible API error (${response.status} ${response.statusText}): ${errorBody}`
      );
    }

    // Some endpoints return 202 with empty body
    if (response.status === 202) {
      return { status: 'accepted' };
    }

    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  // =========================================================================
  // Stats API v2 - POST /api/v2/query
  // =========================================================================

  /**
   * Query analytics data from Plausible Stats API v2
   * This is the primary endpoint for retrieving analytics data.
   */
  async query(params: {
    site_id: string;
    metrics: string[];
    date_range: string | string[];
    dimensions?: string[];
    filters?: unknown[];
    order_by?: Array<[string, string]>;
    include?: Record<string, boolean>;
    pagination?: { limit?: number; offset?: number };
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      site_id: params.site_id,
      metrics: params.metrics,
      date_range: params.date_range,
    };

    if (params.dimensions && params.dimensions.length > 0) {
      body.dimensions = params.dimensions;
    }
    if (params.filters && params.filters.length > 0) {
      body.filters = params.filters;
    }
    if (params.order_by && params.order_by.length > 0) {
      body.order_by = params.order_by;
    }
    if (params.include && Object.keys(params.include).length > 0) {
      body.include = params.include;
    }
    if (params.pagination) {
      body.pagination = params.pagination;
    }

    return this.request('POST', '/api/v2/query', body);
  }

  /**
   * Get real-time visitors count
   * GET /api/v1/stats/realtime/visitors?site_id=<site_id>
   */
  async getRealtimeVisitors(siteId: string): Promise<unknown> {
    return this.request('GET', `/api/v1/stats/realtime/visitors?site_id=${encodeURIComponent(siteId)}`);
  }

  // =========================================================================
  // Events API - POST /api/event
  // =========================================================================

  /**
   * Record a pageview or custom event
   */
  async sendEvent(params: {
    domain: string;
    name: string;
    url: string;
    referrer?: string;
    props?: Record<string, string>;
    revenue?: { currency: string; amount: string | number };
    userAgent?: string;
    ip?: string;
  }): Promise<unknown> {
    const eventUrl = `${this.apiUrl}/api/event`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (params.userAgent) {
      headers['User-Agent'] = params.userAgent;
    }
    if (params.ip) {
      headers['X-Forwarded-For'] = params.ip;
    }

    const body: Record<string, unknown> = {
      domain: params.domain,
      name: params.name,
      url: params.url,
    };

    if (params.referrer) body.referrer = params.referrer;
    if (params.props) body.props = params.props;
    if (params.revenue) body.revenue = params.revenue;

    const response = await fetch(eventUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok && response.status !== 202) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Plausible Events API error (${response.status} ${response.statusText}): ${errorBody}`
      );
    }

    return { status: 'accepted', message: 'Event recorded successfully' };
  }

  // =========================================================================
  // Sites API v1
  // =========================================================================

  /**
   * List all sites in the Plausible account
   * GET /api/v1/sites
   */
  async listSites(params?: {
    limit?: number;
    after?: string;
    before?: string;
  }): Promise<unknown> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.after) query.set('after', params.after);
    if (params?.before) query.set('before', params.before);
    const qs = query.toString();
    return this.request('GET', `/api/v1/sites${qs ? '?' + qs : ''}`);
  }

  /**
   * Get site details
   * GET /api/v1/sites/:site_id
   */
  async getSite(siteId: string): Promise<unknown> {
    return this.request('GET', `/api/v1/sites/${encodeURIComponent(siteId)}`);
  }

  /**
   * Create a new site
   * POST /api/v1/sites
   */
  async createSite(params: {
    domain: string;
    timezone?: string;
    team_id?: string;
  }): Promise<unknown> {
    return this.request('POST', '/api/v1/sites', params);
  }

  /**
   * Update site settings
   * PUT /api/v1/sites/:site_id
   */
  async updateSite(siteId: string, params: {
    domain?: string;
  }): Promise<unknown> {
    return this.request('PUT', `/api/v1/sites/${encodeURIComponent(siteId)}`, params);
  }

  /**
   * Delete a site
   * DELETE /api/v1/sites/:site_id
   */
  async deleteSite(siteId: string): Promise<unknown> {
    return this.request('DELETE', `/api/v1/sites/${encodeURIComponent(siteId)}`);
  }

  /**
   * Find or create a shared link
   * PUT /api/v1/sites/shared-links
   */
  async createSharedLink(siteId: string, name: string): Promise<unknown> {
    return this.request('PUT', '/api/v1/sites/shared-links', {
      site_id: siteId,
      name,
    });
  }

  /**
   * List goals for a site
   * GET /api/v1/sites/goals?site_id=<site_id>
   */
  async listGoals(siteId: string, params?: {
    limit?: number;
    after?: string;
    before?: string;
  }): Promise<unknown> {
    const query = new URLSearchParams();
    query.set('site_id', siteId);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.after) query.set('after', params.after);
    if (params?.before) query.set('before', params.before);
    return this.request('GET', `/api/v1/sites/goals?${query.toString()}`);
  }

  /**
   * Find or create a goal
   * PUT /api/v1/sites/goals
   */
  async createGoal(params: {
    site_id: string;
    goal_type: 'event' | 'page';
    event_name?: string;
    page_path?: string;
    display_name?: string;
  }): Promise<unknown> {
    return this.request('PUT', '/api/v1/sites/goals', params);
  }

  /**
   * Delete a goal
   * DELETE /api/v1/sites/goals/:goal_id
   */
  async deleteGoal(goalId: string, siteId: string): Promise<unknown> {
    return this.request('DELETE', `/api/v1/sites/goals/${encodeURIComponent(goalId)}`, {
      site_id: siteId,
    });
  }

  // =========================================================================
  // Health Check
  // =========================================================================

  /**
   * Check Plausible API health
   * GET /api/health
   */
  async checkHealth(): Promise<unknown> {
    return this.request('GET', '/api/health');
  }
}

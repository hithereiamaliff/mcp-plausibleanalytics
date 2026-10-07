/**
 * Plausible Sites API (/api/v1/sites/*) — Plausible Cloud only.
 *
 * Self-hosted Community Edition does not compile these routes (they are Enterprise-only),
 * so this client is only ever constructed for plausible.io connections.
 * Read endpoints work with a regular Stats API key; writes need a Sites API key.
 */

import { plausibleRequest } from './http.js';

export interface CursorPage {
  limit?: number;
  after?: string;
  before?: string;
}

export interface SitesMeta {
  after?: string | null;
  before?: string | null;
  limit?: number;
}

export interface CloudSite {
  domain: string;
  timezone?: string;
  custom_properties?: string[];
  tracker_script_configuration?: Record<string, unknown>;
}

export interface CloudGoal {
  id: number | string;
  goal_type: 'event' | 'page';
  display_name?: string;
  event_name?: string | null;
  page_path?: string | null;
  custom_props?: Record<string, string>;
}

export class SitesClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const { data } = await plausibleRequest<T>(this.baseUrl, path, {
      method,
      auth: { type: 'bearer', token: this.apiKey },
      ...options,
    });
    return data;
  }

  listSites(page: CursorPage = {}) {
    return this.call<{ sites: CloudSite[]; meta: SitesMeta }>('GET', '/api/v1/sites', { query: { ...page } });
  }

  getSite(siteId: string) {
    return this.call<CloudSite>('GET', `/api/v1/sites/${encodeURIComponent(siteId)}`);
  }

  createSite(params: { domain: string; timezone?: string; team_id?: string }) {
    return this.call<CloudSite>('POST', '/api/v1/sites', { body: params });
  }

  updateSite(siteId: string, params: { domain?: string; tracker_script_configuration?: Record<string, unknown> }) {
    return this.call<CloudSite>('PUT', `/api/v1/sites/${encodeURIComponent(siteId)}`, { body: params });
  }

  deleteSite(siteId: string) {
    return this.call<{ deleted: boolean | string }>('DELETE', `/api/v1/sites/${encodeURIComponent(siteId)}`);
  }

  listGoals(siteId: string, page: CursorPage = {}) {
    return this.call<{ goals: CloudGoal[]; meta: SitesMeta }>('GET', '/api/v1/sites/goals', {
      query: { site_id: siteId, ...page },
    });
  }

  putGoal(params: {
    site_id: string;
    goal_type: 'event' | 'page';
    event_name?: string;
    page_path?: string;
    display_name?: string;
    custom_props?: Record<string, string>;
  }) {
    return this.call<CloudGoal & { domain?: string }>('PUT', '/api/v1/sites/goals', { body: params });
  }

  deleteGoal(siteId: string, goalId: string | number) {
    return this.call<{ deleted: boolean | string }>('DELETE', `/api/v1/sites/goals/${encodeURIComponent(String(goalId))}`, {
      body: { site_id: siteId },
    });
  }

  putSharedLink(siteId: string, name: string) {
    return this.call<{ name: string; url: string }>('PUT', '/api/v1/sites/shared-links', {
      body: { site_id: siteId, name },
    });
  }

  listCustomProps(siteId: string) {
    return this.call<{ custom_properties: Array<{ property: string }> }>('GET', '/api/v1/sites/custom-props', {
      query: { site_id: siteId },
    });
  }

  putCustomProp(siteId: string, property: string) {
    return this.call<{ created: boolean }>('PUT', '/api/v1/sites/custom-props', {
      body: { site_id: siteId, property },
    });
  }

  deleteCustomProp(siteId: string, property: string) {
    return this.call<{ deleted: boolean }>('DELETE', `/api/v1/sites/custom-props/${encodeURIComponent(property)}`, {
      body: { site_id: siteId },
    });
  }
}

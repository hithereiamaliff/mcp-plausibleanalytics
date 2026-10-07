/**
 * Plausible Plugins API (/api/plugins/v1/*).
 *
 * Shipped by self-hosted Community Edition (and Cloud). Built for Plausible's WordPress
 * plugin and not documented on plausible.io — the live spec is served at
 * {base}/api/plugins/spec/openapi. Authenticates with a site-scoped Plugin Token over
 * HTTP Basic auth (site domain as username, token as password).
 */

import { plausibleRequest } from './http.js';

export interface PluginsPagination {
  has_next_page?: boolean;
  has_prev_page?: boolean;
  links?: { next?: { url?: string }; prev?: { url?: string } };
}

export type PluginGoal =
  | { goal_type: 'Goal.CustomEvent'; goal: { id: number; display_name: string; event_name: string; custom_props?: Record<string, string> } }
  | { goal_type: 'Goal.Pageview'; goal: { id: number; display_name: string; path: string; custom_props?: Record<string, string> } }
  | { goal_type: 'Goal.Revenue'; goal: { id: number; display_name: string; event_name: string; currency: string; custom_props?: Record<string, string> } };

export type PluginGoalCreate =
  | { goal_type: 'Goal.CustomEvent'; goal: { event_name: string; custom_props?: Record<string, string> } }
  | { goal_type: 'Goal.Pageview'; goal: { path: string; custom_props?: Record<string, string> } };

export interface PluginSharedLink {
  id: number;
  name: string;
  password_protected: boolean;
  href: string;
}

export interface TrackerScriptConfiguration {
  id?: string;
  installation_type?: 'manual' | 'wordpress' | 'gtm' | 'npm';
  hash_based_routing?: boolean;
  outbound_links?: boolean;
  file_downloads?: boolean;
  form_submissions?: boolean;
}

/** Extract the opaque `after` cursor from a pagination link */
export function nextCursor(pagination?: PluginsPagination): string | undefined {
  if (!pagination?.has_next_page) return undefined;
  const url = pagination.links?.next?.url;
  if (!url) return undefined;
  try {
    return new URL(url, 'http://placeholder').searchParams.get('after') ?? undefined;
  } catch {
    return undefined;
  }
}

export class PluginsClient {
  constructor(
    readonly baseUrl: string,
    readonly siteId: string,
    private readonly token: string,
  ) {}

  private async call<T>(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const { data } = await plausibleRequest<T>(this.baseUrl, `/api/plugins/v1${path}`, {
      method,
      auth: { type: 'basic', username: this.siteId, password: this.token },
      ...options,
    });
    return data;
  }

  capabilities() {
    return this.call<{ authorized: boolean; data_domain: string | null; features: Record<string, boolean> }>(
      'GET',
      '/capabilities',
    );
  }

  listGoals(page: { limit?: number; after?: string } = {}) {
    return this.call<{ goals: PluginGoal[]; meta: { pagination: PluginsPagination } }>('GET', '/goals', {
      query: { ...page },
    });
  }

  /** Idempotent get-or-create */
  createGoal(goal: PluginGoalCreate) {
    return this.call<{ goals: PluginGoal[] }>('PUT', '/goals', { body: goal });
  }

  deleteGoal(goalId: number | string) {
    return this.call<null>('DELETE', `/goals/${encodeURIComponent(String(goalId))}`);
  }

  listSharedLinks(page: { limit?: number; after?: string } = {}) {
    return this.call<{ shared_links: Array<{ shared_link: PluginSharedLink }>; meta: { pagination: PluginsPagination } }>(
      'GET',
      '/shared_links',
      { query: { ...page } },
    );
  }

  /** Idempotent get-or-create by name */
  createSharedLink(name: string, password?: string) {
    return this.call<{ shared_link: PluginSharedLink }>('PUT', '/shared_links', {
      body: { shared_link: password ? { name, password } : { name } },
    });
  }

  enableCustomProps(keys: string[]) {
    return this.call<{ custom_props: Array<{ custom_prop: { key: string } }> }>('PUT', '/custom_props', {
      body: { custom_props: keys.map(key => ({ custom_prop: { key } })) },
    });
  }

  disableCustomProps(keys: string[]) {
    return this.call<null>('DELETE', '/custom_props', {
      body: { custom_props: keys.map(key => ({ custom_prop: { key } })) },
    });
  }

  getTrackerConfig() {
    return this.call<{ tracker_script_configuration: TrackerScriptConfiguration }>('GET', '/tracker_script_configuration');
  }

  updateTrackerConfig(config: TrackerScriptConfiguration) {
    return this.call<{ tracker_script_configuration: TrackerScriptConfiguration }>('PUT', '/tracker_script_configuration', {
      body: { tracker_script_configuration: config },
    });
  }
}

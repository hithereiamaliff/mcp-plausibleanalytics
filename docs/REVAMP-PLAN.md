# Plausible Analytics MCP — Revamp Plan (v2.0.0)

> Status: **IMPLEMENTED** 2026-10-08 (approved as drafted; work committed directly on `main` per review) — see §12 for
> implementation notes and verification results.
> Target: rebuild `mcp-plausibleanalytics` on the architecture of `mcp-github` v2 + the April-2026 key-service
> pattern (`mcp-ghostcms` / `mcp-grabmaps` / `mcp-ltadatamallsg`), CE-first for self-hosted Plausible.

---

## 0. TL;DR

1. **The Sites API does not exist on self-hosted Plausible Community Edition (CE).** Verified in Plausible's
   source at tag `v3.2.1` (latest CE, 2026-05-15): the `/api/v1/sites` routes sit inside an `on_ee do` block in
   `lib/plausible_web/router.ex`, and CE images are built with `MIX_ENV=ce`. CE's "New API key" screen can only
   create Stats API keys. → 9 of the current 19 tools (site/goal/shared-link management) **cannot work on your
   instance today**.
2. CE *does* ship the (undocumented) **Plugins API** (`/api/plugins/v1/*`, per-site token, Basic auth): goals,
   shared links, custom-property allow-listing, tracker-script config. That is how we bring management back on CE.
3. The HTTP server is rebuilt on the **mcp-github v2 skeleton** (fresh `McpServer` + transport per request,
   auth modes, `HttpError`, gated analytics, server card) with the **ghostcms key-service resolver**
   (60 s cache, in-flight de-dupe, correct 401 handling, `server_id`).
4. **mcp-key-service** gets a new `plausible` connector (URL + Stats key + optional sites / plugin tokens /
   write opt-in). Users get `https://mcp.techmavie.digital/plausibleanalytics/mcp/usr_…`.
5. Stats tools become CE-aware and LLM-friendly: dimension aliases (`page`, `source`, `country`…), friendly
   filters, period comparison computed client-side (the public API has none), named-column tables instead of
   positional arrays, Plausible error → actionable hint translation, 429 retry, timeouts.
6. **Read-only by default.** Write tools (goals, shared links, events, site CRUD) only appear when the
   connection explicitly opts in; deletes additionally need `confirm: true`.
7. Infra fixes: host port **8087 collides with mcp-exa** (move to 8096, pending your VPS check); compose must
   join the **external** `mcp-network` to reach `mcp-key-service`; README references a workflow and LICENSE
   that don't exist; the MCP is not actually deployed (`/plausibleanalytics/health` → nginx 404) and not on
   npm — so we are free to make breaking changes.

---

## 1. Background

### 1.1 Current state

| Area | Today |
|---|---|
| Code | ~1,100 LOC TypeScript: `index.ts` (stdio), `http-server.ts` (717), `plausible-client.ts`, `firebase-analytics.ts`, `tools/{stats,sites,events}.ts` |
| Tools (19) | `query_stats`, `get_realtime_visitors`, `get_aggregate_stats`, `get_timeseries`, `get_breakdown`, `send_event`, `send_pageview`, `list_sites`, `get_site`, `create_site`, `update_site`, `delete_site`, `create_shared_link`, `list_goals`, `create_goal`, `delete_goal`, `check_plausible_health`, `hello` |
| Auth | Raw Plausible key via `?apiKey=` / `X-Plausible-Api-Key`, falls back to env `PLAUSIBLE_API_KEY` |
| Deps | `@modelcontextprotocol/sdk ^1.17.4` (latest is 1.32.1), zod 3, express 4, firebase-admin 12, node:20-alpine (Node 20 is EOL since 2026-04) |
| Deploy | Dockerfile, compose (host `8087:8080`, private bridge network), nginx `location /plausibleanalytics/`, smithery.yaml (stdio) |
| Live? | **No.** `https://mcp.techmavie.digital/plausibleanalytics/health` → nginx 404. Not published to npm. |

### 1.2 Problems found in the current code

| # | Problem | Where | Impact |
|---|---|---|---|
| P1 | One cached `McpServer` is re-`connect()`ed to a new transport on every stateless request | `http-server.ts:652-670` | Concurrent requests can race; responses can be routed to the wrong transport |
| P2 | Server cache key = `apiUrl + first 8 chars of API key`; map never evicted | `http-server.ts:653` | Prefix collisions share a client; unbounded memory growth |
| P3 | API key in URL query string (`?apiKey=`) | `http-server.ts:608` | Leaks into nginx/proxy logs and client histories |
| P4 | HTTP mode falls back to server env `PLAUSIBLE_API_KEY` | `http-server.ts:610` | Anyone hitting `/mcp` would use the operator's key (mcp-github v2 removed exactly this) |
| P5 | `/analytics`, `/analytics/import` are unauthenticated; raw client IPs stored | `http-server.ts:314-393` | Anyone can read usage data or inflate counters; privacy |
| P6 | Sites API tools advertised to everyone, docs say "Enterprise plan" | `tools/sites.ts` | On CE every call 404s; misleading |
| P7 | Realtime uses legacy v1 only; no v2 alternatives; no comparison support | `tools/stats.ts` | Missing the most common "vs last period" question |
| P8 | `filters: z.any()`, metrics/dimensions free strings, no annotations | `tools/*.ts` | Poor LLM accuracy; clients can't tell read vs destructive tools |
| P9 | Same try/catch block copy-pasted ~18×; raw positional result arrays returned | `tools/*.ts` | Hard to maintain; LLM must map `metrics[i]` to names itself |
| P10 | No timeout, no 429 retry, follows redirects to any host | `plausible-client.ts` | Hangs; SSRF via redirects once URLs are user-supplied |
| P11 | Compose declares `mcp-network` as `driver: bridge` (project-scoped) and binds `0.0.0.0:8087` | `docker-compose.yml` | Can't resolve `mcp-key-service`; port 8087 is already used by **mcp-exa** |
| P12 | `firebase-credentials` is an empty named volume | `docker-compose.yml:23` | Firebase never initialises in Docker |
| P13 | README lists `.github/workflows/deploy-vps.yml` and `LICENSE` — neither exists | `README.md` | Broken docs; no auto-deploy |

### 1.3 What the API research changed (CE v3.2.1 reality)

| API | CE v3.2.1 | Cloud | Notes |
|---|---|---|---|
| Stats API v2 `POST /api/v2/query` | ✅ | ✅ | Main API. `total_revenue`/`average_revenue` are EE-only (stripped from CE schema). `24h` range is cloud-only. No public `comparisons`, `exit_rate`, `realtime`, `time:minute`. |
| Stats API v1 `GET /api/v1/stats/*` | ✅ (legacy) | ✅ | Only first-class realtime endpoint: `/api/v1/stats/realtime/visitors` (unique visitors, last 5 min). |
| Sites API `/api/v1/sites/*` | ❌ (EE-only, 404) | Enterprise (reads with any Stats key) | Can't list sites on CE with any key. |
| Plugins API `/api/plugins/v1/*` | ✅ (undocumented) | ✅ | Site-scoped token, HTTP Basic. Goals, shared links, custom props (enable/disable, no list), tracker config (CE ≥3.1). |
| Events API `POST /api/event` | ✅ | ✅ | Revenue ignored on CE. Pollutes real data → opt-in only. |
| `GET /api/system`, `/api/system/health/{live,ready}` | ✅ (≥3.0) | ✅ | Version + geo DB, no auth. |
| `GET /api/docs/query/schema.json` | ✅ | ✅ | Exact v2 schema the instance accepts — used for capability detection. |
| Rate limit | 1,000,000 req/h per key | 600 req/h per key | 429 JSON error. |

Version-gated v2 features on CE: `time_on_page`, `scroll_depth`, `has_done`/`has_not_done`, `case_sensitive`,
segment filters, `28d`/`91d`/`Nd`/`Nmo` need **CE ≥ 3.0**; `include.trim_relative_date_range` needs **≥ 3.1**.
`views_per_visit` cannot be combined with any dimension on CE ≤ 3.2.1.

Plausible itself has an **official MCP in progress** (`POST /mcp` on master, OAuth, currently 501; tools
`list_sites`, `query_stats` WIP). Not released, not in CE. Our server stays relevant for CE and adds far more
tooling; worth re-checking at the next CE release.

---

## 2. Target architecture

### 2.1 Reference sources (what we copy from where)

| Piece | Source | Why |
|---|---|---|
| HTTP skeleton, auth modes, `HttpError`, server card, gated analytics, diagnostics, startup banner | `mcp-github` v2.0 `src/http-server.ts` | Canonical, most recent full revamp (2026-03-16) |
| Key-service resolver | `mcp-ghostcms` `src/utils/key-service.ts` (2026-04-03) | Cache + de-dupe + correct 401 → `invalid_key`, sends `server_id`. (mcp-github's resolver maps 401 → 502 — don't copy.) |
| Credentials into tools via closure factory | `mcp-grabmaps` / `mcp-nextcloud` `createMcpServer(credentials)` | Simplest correct per-request isolation |
| External `mcp-network` | `mcp-ghostcms` / `mcp-grabmaps` compose | Required to reach `http://mcp-key-service:8090` |
| Firebase + local analytics | current repo / ghostcms / grabmaps / lta | Your April-batch MCPs all use it (see decision D4) |
| Robust deploy workflow | `mcp-key-service` `deploy.yml` + `mcp-perplexity` fetch/reset | Avoids divergent-branch failures, waits for health |
| 429 backoff | `mcp-keywords-everywhere` | Proven |
| Non-root Docker user | `mcp-ghostcms` | Security |

Bugs explicitly **not** copied: github's tool errors without `isError`, github's 401→502 mapping,
perplexity/nextcloud resolvers ignoring 401, keywords-everywhere's wrong healthcheck port, bridge-only network.

### 2.2 Target file tree

```
mcp-plausibleanalytics/
├── src/
│   ├── cli.ts                      # stdio entry (npm bin) — env: PLAUSIBLE_API_KEY, PLAUSIBLE_URL, PLAUSIBLE_SITES, …
│   ├── http-server.ts              # Express app: CORS, auth modes, routes, per-request server, banner, shutdown
│   ├── index.ts                    # createAppServer(connection) + registerAllTools — shared by cli & http
│   ├── config.ts                   # PlausibleConnection type, normalizeConnection(), SSRF guard
│   ├── plausible/
│   │   ├── client.ts               # Stats v2/v1, Events, system/schema — timeouts, 429 retry, PlausibleApiError
│   │   ├── plugins-client.ts       # Plugins API (CE management), Basic auth per site token
│   │   ├── sites-client.ts         # Sites API (cloud only)
│   │   ├── profile.ts              # Instance detection (version, edition, schema, Sites API) + 10-min cache
│   │   ├── query-helpers.ts        # dimension aliases, friendly filters, date-range validation, comparison ranges
│   │   └── format.ts               # named-column rows, markdown tables, number/duration formatting, error hints
│   ├── tools/
│   │   ├── core.ts                 # hello, get_instance_info, list_sites
│   │   ├── stats.ts                # overview, aggregate, timeseries, breakdown, conversions, compare, realtime, query_stats
│   │   ├── management.ts           # goals, shared links, custom props, tracker config (Plugins API / Sites API)
│   │   ├── sites.ts                # cloud-only site admin (get/create/update/delete site)  [decision D2]
│   │   └── events.ts               # send_event (opt-in)
│   ├── utils/
│   │   ├── key-service.ts          # resolver (ghostcms pattern), server_id 'plausible'
│   │   ├── http-error.ts           # HttpError(status, code, message)
│   │   └── mask.ts                 # maskSecret(), hashIp(), normalizeRoute()
│   └── analytics/
│       ├── firebase-analytics.ts   # (moved from src/, fixed)
│       ├── tracker.ts              # counters, persistence (Firebase + local JSON), sanitisation
│       └── dashboard.ts            # HTML dashboard (prompts for MCP_API_KEY, like mcp-github)
├── test/                           # node:test via tsx — unit tests for helpers, resolver, guard, formatting
├── scripts/smoke-mcp.mjs           # e2e: boots server + fake key-service + fake Plausible, drives it with the MCP SDK client
├── deploy/
│   ├── DEPLOYMENT.md               # runbook + verification curl sequence (mcp-github style)
│   └── nginx-mcp.conf              # location /plausibleanalytics/ → 127.0.0.1:8096
├── .github/workflows/deploy-vps.yml
├── Dockerfile  docker-compose.yml  .env.sample  .gitignore  .npmignore  LICENSE
├── package.json  package-lock.json  tsconfig.json
└── README.md
```

Removed: `smithery.yaml`, `docs/creating-mcp-server.md`, `docs/deployments.png`, `docs/repo_selection.png`
(old AVIMBU Smithery guide — decision D5). `src/index.ts` changes role from stdio entry to shared factory (as in mcp-github).

### 2.3 Request flow (hosted mode)

```
Claude / Cursor / …
  │  POST https://mcp.techmavie.digital/plausibleanalytics/mcp/usr_<32hex>
  ▼
nginx (TLS) ── location /plausibleanalytics/ ──► 127.0.0.1:8096 ► container :8080
  ▼
http-server.ts
  1. validate ^usr_[a-f0-9]{32}$
  2. resolveKeyCredentials(usr_…) ──POST──► http://mcp-key-service:8090/internal/resolve   (60 s cache, de-dupe)
       ◄── { valid, credentials: { plausible_url, plausible_api_key, plausible_sites, … } }
  3. normalizeConnection() → defaults, trim, parse lists; SSRF guard on plausible_url
  4. getInstanceProfile(url, key) (cached 10 min) → version, edition, sitesApi, schema
  5. createAppServer(connection, profile) → fresh McpServer with only the tools this connection can use
  6. fresh StreamableHTTPServerTransport (stateless) → handleRequest → cleanup on finish/close
  ▼
Plausible instance (https://plausible.example.com/api/v2/query, …)
```

### 2.4 Authentication modes

| Mode | Endpoint | Client sends | Credentials come from |
|---|---|---|---|
| **Hosted (key service)** — recommended | `/mcp/usr_…` | nothing else | `/internal/resolve` |
| Hosted, query form | `/mcp?api_key=usr_…` | — | `/internal/resolve` |
| Self-hosted HTTP | `/mcp` | `X-API-Key: <MCP_API_KEY>` + `X-Plausible-Api-Key` (+ optional `X-Plausible-Url`, `X-Plausible-Sites`, `X-Plausible-Plugin-Tokens`, `X-Plausible-Allow-Writes`) | headers |
| CLI / stdio | `npx mcp-plausibleanalytics` | env `PLAUSIBLE_API_KEY`, `PLAUSIBLE_URL`, `PLAUSIBLE_SITES`, `PLAUSIBLE_PLUGIN_TOKENS`, `PLAUSIBLE_ALLOW_WRITES` | env |
| Nothing | `/mcp` | — | **401 `missing_auth`** (no env fallback, fail closed) |

The legacy `?apiKey=` raw-key mode is **dropped** (it was never live). Self-hosted mode returns 503 if
`MCP_API_KEY` is unset (fail closed, as in mcp-github).

### 2.5 HTTP endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /` | — | Server info + endpoint map |
| `GET /health` | — | `{status, server, version, transport, keyService: configured?, timestamp}` |
| `GET /.well-known/mcp/server-card.json` | — | MCP server card (endpoint from `PUBLIC_BASE_PATH`) |
| `ALL /.well-known/oauth-*` | — | Deliberate JSON 404 (stops clients attempting OAuth) |
| `ALL /mcp/:userKey` | usr_ key | Hosted mode (registered before `/mcp`) |
| `ALL /mcp` | query `api_key` / self-hosted headers | Hosted query form or self-hosted mode |
| `GET /analytics`, `/analytics/tools` | `X-API-Key` | Usage JSON (IPs hashed, user keys never logged) |
| `POST /analytics/import` | `X-API-Key` | Merge a backup |
| `GET /analytics/dashboard` | key prompted in page | Chart.js dashboard (key kept in sessionStorage) |
| `ALL /mcp-debug/open` | `ENABLE_MCP_DIAGNOSTICS=true` only | `diagnostics_ping` tool for client debugging |

### 2.6 Environment variables (HTTP server)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address in container |
| `MCP_API_KEY` | — | Gate for self-hosted `/mcp` mode and analytics endpoints |
| `KEY_SERVICE_URL` | — | **Full** resolve URL, e.g. `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | — | This server's token from key-service `INTERNAL_SERVER_TOKENS` (`plausible:<hex>`) |
| `ALLOWED_ORIGINS` | `*` | CORS allowlist |
| `PUBLIC_BASE_PATH` | `/plausibleanalytics` | For server card / examples |
| `ALLOW_PRIVATE_PLAUSIBLE_HOSTS` | — | Comma list of hostnames exempt from the SSRF private-IP block (e.g. an internal Plausible) |
| `PLAUSIBLE_TIMEOUT_MS` | `30000` | Upstream request timeout |
| `ENABLE_MCP_DIAGNOSTICS` / `MCP_TRACE_HTTP` | `false` | Debug aids (keys masked) |
| `ANALYTICS_DIR` | `/app/data` | Local analytics JSON |
| `FIREBASE_DATABASE_URL` / `FIREBASE_SERVICE_ACCOUNT_PATH` | derived / `/app/.credentials/firebase-service-account.json` | Firebase analytics (D4) |

Startup fails fast if only one of `KEY_SERVICE_URL`/`KEY_SERVICE_TOKEN` is set (keywords-everywhere behaviour).

---

## 3. mcp-key-service integration

### 3.1 New connector — `D:\Codeium\mcp-key-service\src\connectors.ts`

Field keys use the prefixed snake_case style of the newest connector (`ghost_url`, `ghost_admin_key`).

```ts
plausible: {
  label: 'Plausible Analytics',
  fields: [
    { key: 'plausible_url', label: 'Plausible Instance URL', type: 'url', required: false,
      placeholder: 'https://plausible.example.com',
      helpText: 'Your self-hosted Plausible URL. Leave blank for Plausible Cloud (https://plausible.io).' },
    { key: 'plausible_api_key', label: 'Stats API Key', type: 'password', required: true,
      helpText: 'Plausible → Account Settings → API Keys → New API Key.' },
    { key: 'plausible_sites', label: 'Site Domains', type: 'text', required: false,
      placeholder: 'example.com, blog.example.com',
      helpText: 'Comma-separated. The first is the default site. Needed on self-hosted (no Sites API) so tools know your sites.' },
    { key: 'plausible_plugin_tokens', label: 'Plugin Tokens (optional)', type: 'password', required: false,
      placeholder: 'example.com=TOKEN, blog.example.com=TOKEN',
      helpText: 'Enables goal / shared-link / custom-property tools. Site Settings → Integrations → Plugin Tokens.' },
    { key: 'plausible_allow_writes', label: 'Allow Write Tools', type: 'text', required: false,
      placeholder: 'no',
      helpText: 'Type "yes" to enable tools that change data (create goals, shared links, send events).' },
  ],
  servers: ['plausible'],
  urlPath: 'plausibleanalytics',   // → https://mcp.techmavie.digital/plausibleanalytics/mcp?api_key=usr_…
},
```

(Fields 4–5 depend on decisions D1/D3; drop them if you decline those.)

### 3.2 Server token

- `server_id` = `plausible`. On the VPS, append `plausible:$(openssl rand -hex 32)` to
  `INTERNAL_SERVER_TOKENS` in `/opt/mcp-key-service/.env`, restart the key service.
- The same token goes into `KEY_SERVICE_TOKEN` in `/opt/mcp-servers/plausibleanalytics/.env`.

### 3.3 Credential handling in the MCP

The key service stores fields verbatim (no trim, no defaults; a cleared optional field may arrive as `''`).
`normalizeConnection()` therefore:

- trims every value; `plausible_url` empty → `https://plausible.io`; strips trailing `/`; must be `http(s)`;
- parses `plausible_sites` (comma/space separated, lowercased, de-duped; first = default site);
- parses `plausible_plugin_tokens` (`domain=token` pairs) into a map; ignores malformed pairs with a warning;
- `plausible_allow_writes` ∈ {yes, true, 1, on} → `true`.

**SSRF guard** (hosted + self-hosted HTTP modes, not CLI): resolve the hostname, reject loopback / RFC1918 /
link-local / CGNAT / ULA / metadata IPs unless listed in `ALLOW_PRIVATE_PLAUSIBLE_HOSTS`; `redirect: 'manual'`
on every upstream fetch (a 3xx becomes an error with a "use the final https URL" hint). This stops a user
pointing `plausible_url` at `http://mcp-key-service:8090` or other containers.

Resolver behaviour (ghostcms pattern): `401`/`404`/`valid:false` → `invalid_key` → HTTP 403 JSON-RPC error
"Invalid or expired API key"; `400`/`403`/`500`/timeouts → `service_unavailable` → 503; non-JSON →
`malformed_response` → 502. Cache successes for 60 s, keyed by the `usr_` key (in memory only).
Log only `usr_xxxxxxxx…` prefixes.

### 3.4 Checklist — `mcp-key-service` repo (template: commit `e053aff`, YouTube connector)

- [ ] `src/connectors.ts` — add the entry above.
- [ ] `README.md` — Supported Connectors table + "Supported server IDs" list.
- [ ] `.env.sample` — mention `plausible:<token>` in the `INTERNAL_SERVER_TOKENS` comment.
- [ ] `scripts/smoke-test.mjs` — add a plausible server token + register/resolve test; rebalance the
      register rate-limit loop and asserted totals (5 registrations/IP/hour budget).
- [ ] Optional: add Plausible to the portal landing copy (`portal/src/app/page.tsx`).
- [ ] `npm test` passes.

No billing/pricing change needed (pricing is not per connector).

---

## 4. Plausible API coverage & tool design

### 4.1 Instance profile (`plausible/profile.ts`)

Computed once per `(base URL, key hash)` and cached 10 minutes:

| Probe | Call | Used for |
|---|---|---|
| Version & geo DB | `GET /api/system` (no auth) | `get_instance_info`; version-gated hints (e.g. `28d` needs ≥3.0); warn if city/region data unavailable |
| Schema | `GET /api/docs/query/schema.json` (no auth) | Allowed metrics / date ranges / include keys; edition (revenue metrics present ⇒ cloud/EE) |
| Sites API | `GET /api/v1/sites?limit=1` (auth) | 200 ⇒ register cloud site tools + real `list_sites`; 404 ⇒ CE |
| Key check | cheap `POST /api/v2/query` `{metrics:[visitors],date_range:"day"}` on default site (only in `get_instance_info`) | Clear "key invalid / site not accessible" diagnostics |

If probes fail (old instance, network), the server still registers the core + stats tools and reports the
probe error in `get_instance_info`.

### 4.2 Tool catalogue

Annotations: **RO** = `readOnlyHint: true`; **W** = write, `idempotentHint` where the API is find-or-create;
**D** = `destructiveHint: true` + required `confirm: true`. All tools are `openWorldHint: true`.
`site_id` is optional everywhere when a default site is configured.

**Core (always)**

| Tool | Ann. | API | Notes |
|---|---|---|---|
| `hello` | RO | — | Version, transport, auth mode, instance host, default site |
| `get_instance_info` | RO | system, health, schema, probes | Replaces `check_plausible_health`: version, edition, geo DB, which tool groups are enabled and why, supported metrics/ranges |
| `list_sites` | RO | Sites API (cloud) / configured sites (CE) | On CE explains that sites come from the connection's `plausible_sites` |

**Stats (always; Stats API key)**

| Tool | Ann. | What it does |
|---|---|---|
| `get_site_overview` | RO | One-call dashboard: KPIs + change vs previous period, top pages, sources, countries, devices (parallel v2 queries), compact markdown |
| `get_aggregate_stats` | RO | KPIs for a range; `compare: none \| previous_period \| year_over_year` (two queries, client-side deltas using the resolved `query.date_range` Plausible echoes back — timezone-correct) |
| `get_timeseries` | RO | `interval: auto\|hour\|day\|week\|month`; `time_labels` to zero-fill empty buckets |
| `get_breakdown` | RO | Any dimension (full name or alias: `page`, `entry_page`, `exit_page`, `source`, `referrer`, `channel`, `utm_*`, `device`, `browser`, `os`, `country`, `region`, `city`, `hostname`, `goal`, `prop:<name>`), metrics, friendly filters, `limit`/`offset`, `total_rows`, order |
| `get_goal_conversions` | RO | `event:goal` breakdown: visitors, events, conversion_rate (+ revenue on cloud); optional goal filter and prop sub-breakdown |
| `compare_periods` | RO | Two arbitrary ranges (or preset), optional dimension → per-row deltas & % change |
| `get_realtime_visitors` | RO | v1 current visitors + optional last-N-minutes (default 30) top pages / sources via v2 datetime range |
| `query_stats` | RO | Raw v2 escape hatch: full schema (metrics enum, dimensions, nested `and/or/not/has_done` filters, `order_by`, `include`, `pagination`), returned as named-column rows + meta |

**Management (when the connection has a backend for it)**

| Tool | Ann. | CE (Plugins API, needs site plugin token) | Cloud (Sites API key) |
|---|---|---|---|
| `list_goals` | RO | ✅ | ✅ |
| `create_goal` | W (idempotent) | ✅ event/page goals, custom props | ✅ |
| `delete_goal` | D | ✅ | ✅ |
| `list_shared_links` | RO | ✅ | — (no API) |
| `create_shared_link` | W (idempotent) | ✅ optional password | ✅ |
| `enable_custom_property` / `disable_custom_property` | W / D | ✅ | ✅ |
| `get_tracker_config` / `update_tracker_config` | RO / W | ✅ (CE ≥ 3.1) | via site details |

**Cloud site admin (auto-hidden on CE)** — decision D2

| Tool | Ann. | Notes |
|---|---|---|
| `get_site` | RO | domain, timezone, custom props, tracker config |
| `create_site` / `update_site` | W | needs Sites API key with provisioning scope |
| `delete_site` | D | requires `confirm: true`; warns data deletion is irreversible |

**Events (opt-in)**

| Tool | Ann. | Notes |
|---|---|---|
| `send_event` | W | Merges `send_event` + `send_pageview` (`name` defaults to `pageview`). Only with `allow_writes`. Description recommends a test site; surfaces `x-plausible-dropped`; requires `user_agent`, warns that missing/real IP affects counting and bot filtering. |

Write tools (marked W/D) are **only registered when `allow_writes` is on** (decision D3). Reads never need it.
Max surface: 11 always-on + up to 9 management + 4 cloud + 1 events; a typical CE read-only connection sees 11.

### 4.3 Old → new tool mapping

| Old | New |
|---|---|
| `query_stats` | `query_stats` (typed schema, hints, named rows) |
| `get_aggregate_stats` | `get_aggregate_stats` (+ `compare`) |
| `get_timeseries` | `get_timeseries` (zero-filled) |
| `get_breakdown` | `get_breakdown` (aliases, offset, total_rows) |
| `get_realtime_visitors` | `get_realtime_visitors` (+ recent activity) |
| `send_event`, `send_pageview` | `send_event` (opt-in) |
| `list_sites` | `list_sites` (CE fallback) |
| `list_goals`, `create_goal`, `delete_goal`, `create_shared_link` | same names, CE via Plugins API, cloud via Sites API |
| `get_site`, `create_site`, `update_site`, `delete_site` | cloud-only, auto-hidden (D2) |
| `check_plausible_health` | `get_instance_info` |
| `hello` | `hello` |
| — | **new:** `get_site_overview`, `get_goal_conversions`, `compare_periods`, `get_instance_info`, `list_shared_links`, `enable_custom_property`, `disable_custom_property`, `get_tracker_config`, `update_tracker_config` |

### 4.4 Tool conventions

- `server.registerTool(name, { title, description, inputSchema, annotations }, handler)` (SDK ≥ 1.32);
  snake_case, no prefix (matches mcp-github / current names).
- Zod `.describe()` on every parameter with examples; enums for metrics, intervals, operators, aliases.
- **Friendly filters** on convenience tools: `[{ dimension, operator, values, case_sensitive? }]` built into
  v2 filter tuples; raw v2 filters only on `query_stats`.
- **Date ranges**: shorthand enum (`day`, `7d`, `28d`, `30d`, `91d`, `month`, `6mo`, `12mo`, `year`, `all`,
  `Nd`, `Nmo`, cloud `24h`) or `{ from, to }` dates/datetimes; checked against the instance version.
- **Output**: `format: 'markdown' (default) | 'json'`. Markdown = header (site, resolved period, filters),
  named-column table, notes (imports, warnings, "N of total rows — call again with offset=…"). JSON =
  `{ site_id, period, rows: [{ <dimension>: …, <metric>: … }], meta }`. Durations humanised, rates as %.
- **Errors**: one `withToolErrors()` wrapper → always `isError: true`; Plausible 400 messages mapped to hints
  (e.g. *"views_per_visit can't be queried with dimensions on this Plausible version — drop it or use
  visits/pageviews"*, *"conversion_rate needs a goal filter or `goal` dimension"*, *"revenue metrics are
  cloud-only"*, *"the goal X is not configured — call list_goals"*).
- **Client**: `AbortSignal.timeout`, 429 retry with 1/2/4 s backoff (honours `Retry-After`), `redirect: 'manual'`,
  typed `PlausibleApiError { status, message, hint }`, never logs keys.

---

## 5. Implementation phases

Work happens on branch **`revamp/v2`** in this repo (and `feat/plausible-connector` in mcp-key-service).
Nothing is pushed until you approve — **a push to `main` auto-deploys to the VPS in both repos.**

| Phase | Scope | Output |
|---|---|---|
| 1. Scaffold | Upgrade SDK to 1.32.x (zod per SDK peer range), express 4 (sibling parity), tsconfig ES2022/NodeNext, scripts (`build`, `dev`, `dev:http`, `start`, `start:http`, `typecheck`, `test`, `smoke`), `bin → dist/cli.js`, `.npmignore`, MIT `LICENSE` (keeping AVIMBU's original notice), remove Smithery/old guide | Builds clean |
| 2. Core layer | `config.ts` (normalise + SSRF guard), `plausible/client.ts`, `profile.ts`, `utils/key-service.ts`, `http-error.ts`, `mask.ts` | Unit-tested helpers |
| 3. HTTP server | Rewrite `http-server.ts` on mcp-github skeleton; per-request server; auth modes; endpoints; analytics module (Firebase + local, gated, hashed IPs, masked routes); dashboard; server card; banner; graceful shutdown; `cli.ts` | `/health`, `/mcp` all modes working |
| 4. Stats tools | `query-helpers.ts`, `format.ts`, `tools/core.ts`, `tools/stats.ts` | 11 read tools |
| 5. Management & events | `plugins-client.ts`, `sites-client.ts`, `tools/management.ts`, `tools/sites.ts`, `tools/events.ts`, write gating | Conditional registration verified |
| 6. Key service | Connector + README + `.env.sample` + smoke test in mcp-key-service | `npm test` green |
| 7. Docs & deploy files | README (mcp-github structure: Quick Start options → auth modes → tools by category → endpoints → env → dev → structure → security), `deploy/DEPLOYMENT.md`, nginx conf, compose, Dockerfile, workflow, `.env.sample` | Reviewed docs |
| 8. Verification | §6 | Evidence posted back to you |
| 9. Deploy (with you) | §7 runbook | Live endpoint |

Expected size: ~2.5–3.5k LOC including tests.

---

## 6. Testing & verification

1. `npm run typecheck` + `npm run build` clean.
2. **Unit tests** (`node:test` + tsx, no new test framework): `normalizeConnection`, SSRF guard, key-service
   status mapping (mocked fetch: 200 / 401 / 403 / 500 / timeout / non-JSON), dimension aliases + filter
   builder, date-range validation, comparison-range math, row normalisation + markdown formatting, error hints.
3. **E2E smoke** (`scripts/smoke-mcp.mjs`): boots the HTTP server against a fake key-service and a fake
   Plausible (local stub servers), then uses the official SDK client to `initialize`, `tools/list`,
   `tools/call` in every auth mode; asserts write tools are hidden without `allow_writes`, Sites tools hidden
   when the stub returns 404, invalid `usr_` → 403, key-service down → 503, private URL → rejected.
4. **Live read-only check against your CE instance**: you put your instance URL + a Stats API key in a local,
   git-ignored `.env`; I run `get_instance_info`, `get_site_overview`, `get_breakdown`, `compare_periods`,
   `get_realtime_visitors`, `query_stats` via stdio and HTTP. No writes unless you explicitly say so (and then
   only against a test site).
5. MCP Inspector (`npx @modelcontextprotocol/inspector`) sanity pass on the HTTP endpoint.
6. `mcp-key-service`: `npm test` (smoke test incl. new plausible register/resolve).

---

## 7. Deployment runbook (VPS) — done together after review

Order matters: key service first (so the connector exists), then the MCP.

1. **Key service**: merge/push `feat/plausible-connector` → its workflow redeploys. Add
   `plausible:<openssl rand -hex 32>` to `INTERNAL_SERVER_TOKENS` in `/opt/mcp-key-service/.env`, restart.
2. **MCP checkout**: `git clone … /opt/mcp-servers/plausibleanalytics`; create `.env` with `MCP_API_KEY`,
   `KEY_SERVICE_URL=http://mcp-key-service:8090/internal/resolve`, `KEY_SERVICE_TOKEN`, `PUBLIC_BASE_PATH`.
3. **Firebase creds**: mount the existing credentials directory read-only (path to confirm — see D4).
4. **Compose**: `127.0.0.1:8096:8080`, external `mcp-network`, non-root, healthcheck on `127.0.0.1:8080/health`.
5. **nginx**: add `location /plausibleanalytics/ { proxy_pass http://127.0.0.1:8096/; … proxy_buffering off;
   proxy_request_buffering off; proxy_read_timeout 300s; }` to the `mcp.techmavie.digital` server block;
   `nginx -t && systemctl reload nginx`. No root-level server-card block (mcp-nextcloud owns it).
6. **GitHub secrets** on the repo: `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_PORT`.
7. Merge `revamp/v2` → `main` → workflow (`fetch` + `reset --hard`, `build`, `up -d`, health wait).
8. Verification sequence from `deploy/DEPLOYMENT.md` (health, server card, invalid key, hosted path/query,
   self-hosted headers, analytics with/without key), then register a real connection in the portal and
   connect Claude.

---

## 8. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | CE management via **Plugins API** (needs a plugin token per site, created at `https://<plausible>/<domain>/settings/integrations?new_token=MCP`) | **Include** — it's the only way to manage goals/shared links on CE. API is undocumented (built for the WordPress plugin) so treat as best-effort. |
| D2 | **Cloud-only site admin** tools (`get/create/update/delete_site`) — you can't test them on CE | **Keep, auto-hidden on CE** (already written; useful for hosted users on Plausible Cloud Enterprise). Don't add more cloud-only tools (guests/teams). |
| D3 | **Write safety** | **Read-only by default**; one opt-in (`plausible_allow_writes` / `X-Plausible-Allow-Writes` / `PLAUSIBLE_ALLOW_WRITES`) unlocks writes; deletes also need `confirm: true`. |
| D4 | **Usage analytics storage** | **Keep Firebase + local backup** (matches ghostcms/grabmaps/lta), but adopt mcp-github's protections (key-gated endpoints, hashed IPs, masked keys). Alternative: local-only like mcp-github. |
| D5 | **Smithery + old AVIMBU guide** (`smithery.yaml`, `docs/creating-mcp-server.md`, 2 PNGs) | **Remove** (mcp-github v2 dropped Smithery; the guide documents the old upstream code). |
| D6 | **Git workflow** | Branches `revamp/v2` + `feat/plausible-connector`, logical commits, **no push until you say** (push = production deploy). |

### Pending your VPS checks

- Port **8096** free? (`sudo ss -ltnp | grep -E ':(8087|8096)\b'`)
- Firebase credentials location on the VPS (`ls -la /opt/mcp-servers/.credentials /opt/mcp-credentials`)
- Server IDs already in `INTERNAL_SERVER_TOKENS` (masked command given in chat)
- Your Plausible CE version (`docker ps --filter name=plausible --format '{{.Names}}  {{.Image}}'`) — plan
  assumes **≥ 3.0**; if older, version-gated features are hidden/hinted and I'd suggest upgrading to v3.2.1
  (3.2.1 also fixes CVE-2026-8467).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Plugins API is undocumented and may change | Isolated in `plugins-client.ts`; errors surface clearly; only registered when tokens are present |
| Cloud Sites API tools untestable by us | Kept behind live probe; described as best-effort in README |
| User-supplied instance URL → SSRF | DNS-resolved private-IP block, no redirects, http(s) only, allowlist env |
| 60 s credential cache delays revocation | Same trade-off as all sibling MCPs; documented |
| `get_site_overview` fires ~6 queries | Fine on CE (1M/h); on cloud 600/h — documented, and individual tools remain |
| Plausible's official MCP may land in CE | Our server is a superset; revisit at next CE release |
| Breaking changes vs current README | Server was never live and not on npm — no existing users to break |

## 10. Out of scope

Segments CRUD, funnels, annotations, user journeys (no public API); OAuth for the MCP itself; npm
publishing (can be a follow-up once stable); changing key-service pricing or portal UI beyond copy.

## 11. References

- Plausible Stats API v2 — https://plausible.io/docs/stats-api · schema: `priv/json-schemas/query-api-schema.json` @ v3.2.1
- Stats API v1 (legacy) — https://plausible.io/docs/stats-api-v1
- Sites API (EE) — https://plausible.io/docs/sites-api · EE gating: `lib/plausible_web/router.ex` @ v3.2.1 (`on_ee do scope "/api/v1/sites"`)
- Plugins API — `{base}/api/plugins/spec/swagger-ui` · `lib/plausible_web/plugins/api/*` @ v3.2.1
- Events API — https://plausible.io/docs/events-api
- CE releases — https://github.com/plausible/analytics/releases (v3.2.1, 2026-05-15)
- Sibling MCPs: `hithereiamaliff/mcp-github` (v2.0), `mcp-ghostcms` (`src/utils/key-service.ts`), `mcp-grabmaps`, `mcp-forgejo` (`docs/REBUILD-PLAN.md`), `mcp-key-service` (commit `e053aff`)
- Benchmarks: getsentry/plausible-mcp, ickas/plausible-mcp, jason-mspkickstart/mcp-plausible, ICJIA/plausible-mcp

## 12. Implementation notes (2026-10-08)

**Delivered as planned**, with these deviations / additions:

| Item | Note |
|---|---|
| Branching (D6) | Committed directly on `main` in both repos at your request; nothing pushed. |
| Dependencies | SDK 1.32.1, zod 3.25, express 4 (sibling parity), TypeScript 5.9, **firebase-admin 14.5** (13.x pulled vulnerable google-cloud deps), Node 22 (`node:22-alpine`, multi-stage, non-root). Remaining `npm audit`: 2 moderate (`uuid` via `gaxios`, buffer-arg code path not used). |
| `disable_custom_property` | Requires `confirm: true` like the other destructive tools. |
| Stateless endpoint | GET/DELETE on `/mcp` return 405 (SDK stateless pattern) instead of holding an idle SSE stream open. |
| Comparisons | Month-to-date / today / year-to-date comparisons trim the current period to "now" (CE 3.1+ `trim_relative_date_range`) so they compare like-for-like. |
| Extra bug fixed | The old analytics dashboard injected client User-Agent strings via `innerHTML` (stored XSS) — the new dashboard renders with `textContent` and is key-gated. |
| SSRF guard | Node's `BlockList` matches IPv4 against an IPv6 `::ffff:0:0/96` rule, so IPv4/IPv6 lists are kept separate (covered by unit tests). |
| `scripts/live-check.mjs` | New: read-only run of every read tool against your real instance using `.env` (writes forced off). |
| npm | Package not yet published; README documents running from source. |

**Verification**

- `npm run typecheck` — clean.
- `npm test` — 51/51 unit tests (config + SSRF guard, query helpers incl. comparison maths, formatting + error hints, key-service resolver status mapping/cache/de-dupe, HTTP client retries/redirects/auth).
- `npm run smoke` — 26/26 end-to-end checks: real built server + fake key service + fake Plausible, SDK client in hosted path / hosted query / self-hosted header / stdio modes; write gating, `confirm`, 401/403/405/503 paths, SSRF rejection, analytics key-gating and no `usr_` leakage.
- Live call against plausible.io public endpoints: profile parsing (schema/system) and 401 error + hint path verified.
- Docker stages replayed in a clean directory (no local Docker): build → prod-only install → `/health` OK.
- mcp-key-service commit `13568aa`: `npm test` passes.

**Still to do (needs you / the VPS)** — §7 runbook: VPS checks (port 8096, Firebase credentials path, CE version), token in `INTERNAL_SERVER_TOKENS`, `.env`, nginx block, GitHub secrets, push both repos, live check with a real Stats key.

## 13. Deployment notes (2026-10-08)

- **Two hosts:** the MCP servers and mcp-key-service run on the `mcp.techmavie.digital` VPS; self-hosted Plausible runs on a separate VPS (`plausible.mynameisaliff.co.uk`). The MCP reaches Plausible over its public HTTPS URL.
- **Port:** 8096 was already taken on the MCP VPS, so the server runs on **8099** (repo defaults updated).
- **Plausible upgraded** from CE v2.1.1 (no Stats API v2) to **v3.2.1** via v2.1.5 and v3.0.1; secrets moved from the compose file into `/opt/plausible/.env`, `SECRET_KEY_BASE` rotated.
- **Live:** `https://mcp.techmavie.digital/plausibleanalytics/health` healthy (key service configured, Firebase connected); live-check 11/11 against the real instance; public auth paths verified (401 missing auth, 403 invalid key via the real key service, 405 GET, 404 OAuth metadata, 401 analytics without key).

# Plausible Analytics MCP Server

Model Context Protocol server for [Plausible Analytics](https://plausible.io/) — built first for **self-hosted Plausible Community Edition**, and fully compatible with Plausible Cloud.

It ships with up to 26 tools across 5 categories (11 read-only tools on every connection) and supports:

- hosted key-service mode with `usr_...` user keys ([MCP Key Service](https://mcpkeys.techmavie.digital))
- self-hosted Streamable HTTP deployments
- CLI/stdio usage for local MCP clients

**MCP Endpoint:** `https://mcp.techmavie.digital/plausibleanalytics/mcp`

> Originally forked from [AVIMBU/plausible-mcp-server](https://github.com/AVIMBU/plausible-mcp-server); rebuilt in v2 by [@hithereiamaliff](https://github.com/hithereiamaliff).

## Quick Start

### Option 1: Hosted key-service mode (recommended)

1. Go to [mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital), choose **Plausible Analytics** and enter:
   - **Plausible Instance URL** — your self-hosted URL (leave blank for Plausible Cloud)
   - **Stats API Key** — Plausible → Account Settings → API Keys → New API Key
   - **Site Domains** — e.g. `example.com, blog.example.com` (first = default site)
   - *Optional* **Plugin Tokens** — `example.com=TOKEN` to enable goal / shared-link / custom-property tools
   - *Optional* **Allow Write Tools** — `yes` to enable tools that change data
2. Use the `usr_...` key you get back:

```json
{
  "mcpServers": {
    "plausible": {
      "transport": "streamable-http",
      "url": "https://mcp.techmavie.digital/plausibleanalytics/mcp/usr_YOUR_USER_KEY"
    }
  }
}
```

Compatibility query form:

```text
https://mcp.techmavie.digital/plausibleanalytics/mcp?api_key=usr_YOUR_USER_KEY
```

### Option 2: Self-hosted HTTP

Header-based auth on `/mcp` (requires `MCP_API_KEY` on the server):

```json
{
  "mcpServers": {
    "plausible": {
      "transport": "streamable-http",
      "url": "https://your-host/plausibleanalytics/mcp",
      "headers": {
        "X-API-Key": "YOUR_MCP_API_KEY",
        "X-Plausible-Api-Key": "YOUR_PLAUSIBLE_STATS_API_KEY",
        "X-Plausible-Url": "https://plausible.example.com",
        "X-Plausible-Sites": "example.com, blog.example.com"
      }
    }
  }
}
```

Optional headers: `X-Plausible-Plugin-Tokens` (`example.com=TOKEN,...`) and `X-Plausible-Allow-Writes` (`yes`).

### Option 3: CLI / stdio

The package is not on npm yet — build from source:

```bash
git clone https://github.com/hithereiamaliff/mcp-plausibleanalytics.git
cd mcp-plausibleanalytics && npm install && npm run build
```

```json
{
  "mcpServers": {
    "plausible": {
      "command": "node",
      "args": ["/path/to/mcp-plausibleanalytics/dist/cli.js"],
      "env": {
        "PLAUSIBLE_API_KEY": "your_stats_api_key",
        "PLAUSIBLE_URL": "https://plausible.example.com",
        "PLAUSIBLE_SITES": "example.com"
      }
    }
  }
}
```

## Authentication Modes

| Mode | Endpoint | Client auth | Credentials from |
|------|----------|-------------|------------------|
| Hosted key-service | `/mcp/usr_...` | none | MCP Key Service (`plausible` connector) |
| Hosted, query form | `/mcp?api_key=usr_...` | none | MCP Key Service |
| Self-hosted HTTP | `/mcp` | `X-API-Key` | `X-Plausible-*` headers |
| CLI / stdio | — | — | `PLAUSIBLE_*` environment variables |

Raw Plausible keys in the URL (`?apiKey=`) are **not** accepted — they leak into proxy logs. The HTTP server never falls back to a key from its own environment.

## Self-hosted vs Cloud

Plausible Community Edition does **not** include the Sites API (it is Enterprise-only and not compiled into CE), so on self-hosted instances:

- `list_sites` returns the site domains configured on the connection
- goals, shared links, custom properties and tracker settings use the **Plugins API** with a per-site *Plugin Token*. Create one at `https://<your-plausible>/<site>/settings/integrations?new_token=MCP` (the token is shown once).
- revenue metrics and the `24h` range are Cloud-only

Most stats features need **CE 3.0+** (`scroll_depth`, `time_on_page`, behavioral filters, `28d`/`91d` ranges); `get_instance_info` reports what your instance supports. CE v3.0.0–v3.2.0 are affected by CVE-2026-8467 — run v3.2.1 or newer.

## Tool Categories

Tools are registered per connection, so clients only see what the credentials can do.

### Core (3) — always

| Tool | Description |
|------|-------------|
| `hello` | Connectivity check and connection summary |
| `get_instance_info` | Version, edition, health, API-key and plugin-token checks, supported metrics / ranges |
| `list_sites` | Sites API on Cloud; configured site domains on self-hosted |

### Stats (8) — always, read-only

| Tool | Description |
|------|-------------|
| `get_site_overview` | One-call dashboard: KPIs vs previous period, top pages, sources, countries, devices, goals |
| `get_aggregate_stats` | Totals for a range, optional previous-period / year-over-year comparison |
| `get_timeseries` | Metrics per hour / day / week / month, zero-filled |
| `get_breakdown` | Top values of any dimension (aliases like `page`, `source`, `country`, `prop:author`) |
| `get_goal_conversions` | Conversions and conversion rate per goal, optional breakdown |
| `compare_periods` | Two periods side by side, totals or per dimension value, with % / pp change |
| `get_realtime_visitors` | Current visitors plus last-N-minutes top pages and sources |
| `query_stats` | Raw Stats API v2 query (nested filters, segments, behavioral filters, pagination) |

### Management (up to 9) — Plugin Token (self-hosted) or Plausible Cloud

| Tool | Write? | Description |
|------|--------|-------------|
| `list_goals` | | Goals with IDs |
| `list_shared_links` | | Shared dashboard links (Plugin Token only) |
| `get_tracker_config` | | Tracker script options (CE 3.1+) |
| `create_goal` | ✏️ | Event or pageview goal (idempotent) |
| `delete_goal` | ⚠️ | Requires `confirm: true` |
| `create_shared_link` | ✏️ | Optional password (idempotent) |
| `enable_custom_property` | ✏️ | Allow-list custom property keys |
| `disable_custom_property` | ⚠️ | Requires `confirm: true` |
| `update_tracker_config` | ✏️ | Outbound links, file downloads, forms, hash routing |

### Cloud site admin (up to 5) — plausible.io only

`get_site`, `list_custom_properties`, and with writes enabled `create_site`, `update_site`, `delete_site` (⚠️ `confirm: true`). Writes need a Sites API key (Enterprise).

### Events (1) — writes enabled

`send_event` — record a pageview or custom event (e.g. to test a goal). Events count as real traffic and cannot be deleted.

✏️ / ⚠️ tools are only registered when the connection allows writes. All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

## Usage Examples

- "How is example.com doing this month compared with last month?" → `get_site_overview` / `get_aggregate_stats`
- "Top 20 blog pages in the last 28 days with scroll depth" → `get_breakdown` with `page` + `contains /blog`
- "Which sources drive Signup conversions?" → `get_goal_conversions` with `breakdown_by: "source"`
- "Compare countries this quarter vs the same quarter last year" → `compare_periods` with `year_over_year`
- "How many people are on the site right now?" → `get_realtime_visitors`

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `/` | — | Server info |
| `/health` | — | Health check |
| `/.well-known/mcp/server-card.json` | — | MCP server card |
| `/mcp/:userKey` | usr_ key | Hosted key-service mode |
| `/mcp` | `?api_key=` or headers | Hosted query form / self-hosted mode (POST only — stateless) |
| `/analytics`, `/analytics/tools` | `X-API-Key` | Usage JSON (IPs hashed, user keys never recorded) |
| `/analytics/import` | `X-API-Key` | Merge backup totals |
| `/analytics/dashboard` | key prompt | Usage dashboard |
| `/mcp-debug/open` | — | Diagnostics server, only with `ENABLE_MCP_DIAGNOSTICS=true` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `MCP_API_KEY` | — | Enables self-hosted `/mcp` mode and analytics endpoints |
| `KEY_SERVICE_URL` | — | Full resolve URL, e.g. `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | — | This server's token (`plausible:<token>` in the key service) |
| `PUBLIC_BASE_PATH` | — | Public prefix, e.g. `/plausibleanalytics` |
| `ALLOWED_ORIGINS` | `*` | CORS allowlist |
| `ALLOW_PRIVATE_PLAUSIBLE_HOSTS` | — | Hostnames exempt from the private-IP block |
| `PLAUSIBLE_TIMEOUT_MS` | `30000` | Upstream request timeout |
| `MCP_TRACE_HTTP` / `ENABLE_MCP_DIAGNOSTICS` | `false` | Debug aids |
| `ANALYTICS_DIR` | `/app/data` | Local analytics JSON |
| `FIREBASE_SERVICE_ACCOUNT_PATH` / `FIREBASE_DATABASE_URL` | `/app/.credentials/...` / derived | Optional Firebase analytics |
| `PLAUSIBLE_API_KEY`, `PLAUSIBLE_URL`, `PLAUSIBLE_SITES`, `PLAUSIBLE_PLUGIN_TOKENS`, `PLAUSIBLE_ALLOW_WRITES` | — | CLI / stdio only |

## Local Development

```bash
npm install
cp .env.sample .env          # fill in values
npm run dev:http             # HTTP server with tsx
npm run dev:cli              # stdio server with tsx
npm run typecheck
npm test                     # unit tests (node:test)
npm run smoke                # end-to-end test against fake Plausible + key service
npm run live-check           # read-only checks against your real instance (.env)
```

## Project Structure

```
src/
├── cli.ts                    # stdio entry (bin)
├── http-server.ts            # Express app, auth modes, per-request servers
├── index.ts                  # createAppServer + per-connection tool registration
├── config.ts                 # connection normalisation + SSRF guard
├── version.ts
├── plausible/
│   ├── http.ts               # fetch wrapper: timeouts, 429 retry, no redirects
│   ├── client.ts             # Stats v2 / v1 realtime / Events / system endpoints
│   ├── plugins-client.ts     # Plugins API (self-hosted management)
│   ├── sites-client.ts       # Sites API (Cloud)
│   ├── profile.ts            # instance version / schema detection
│   ├── query-helpers.ts      # aliases, filters, date ranges, comparisons
│   └── format.ts             # named rows, markdown tables, error hints
├── tools/                    # core, stats, management, sites, events
├── utils/                    # key-service resolver, HttpError, masking
└── analytics/                # usage tracker, Firebase persistence, dashboard
test/                         # unit tests
scripts/                      # smoke-mcp.mjs, live-check.mjs
deploy/                       # DEPLOYMENT.md, nginx-mcp.conf
```

## Security Notes

- Read-only by default; write tools appear only when the connection opts in, and destructive tools also need `confirm: true`.
- Instance URLs resolving to private / loopback / link-local addresses are rejected and redirects are never followed, so a user-supplied URL cannot reach internal services.
- Self-hosted mode fails closed without `MCP_API_KEY`; keys are compared in constant time.
- Analytics store hashed IPs only; `usr_` keys and Plausible keys are never logged (masked in traces).

## Deployment

See [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md). Pushes to `main` deploy to the VPS via GitHub Actions.

## License

[MIT](./LICENSE)

---

Made with care by [Aliff](https://mynameisaliff.co.uk/) (TechMavie Digital)

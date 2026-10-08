# Plausible Analytics MCP — VPS Deployment Guide

Target: `https://mcp.techmavie.digital/plausibleanalytics/` → nginx → `127.0.0.1:8099` → container `mcp-plausibleanalytics:8080`.

```
Client ──HTTPS──► nginx (/plausibleanalytics/) ──► 127.0.0.1:8099 ──► container :8080
                                                              │
                         mcp-network (external) ◄─────────────┤
                                │                             ▼
                     mcp-key-service:8090            your Plausible instance
```

## Auth Modes

| Mode | Endpoint | Client auth |
|------|----------|-------------|
| Hosted key-service | `/plausibleanalytics/mcp/usr_...` | none (key in path) |
| Hosted, query form | `/plausibleanalytics/mcp?api_key=usr_...` | none |
| Self-hosted | `/plausibleanalytics/mcp` | `X-API-Key` + `X-Plausible-Api-Key` (+ `X-Plausible-Url`, `X-Plausible-Sites`, …) |

## Required Environment

`/opt/mcp-servers/plausibleanalytics/.env` (start from `.env.sample`):

| Variable | Value |
|----------|-------|
| `HOST_PORT` | `8099` on mcp.techmavie.digital (8096 is taken there). Check a port is free with `sudo ss -ltnp \| grep 8099` |
| `MCP_API_KEY` | `openssl rand -hex 32` |
| `KEY_SERVICE_URL` | `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | same token as `plausible:<token>` in the key service |
| `PUBLIC_BASE_PATH` | `/plausibleanalytics` |
| `FIREBASE_CREDENTIALS_DIR` | directory containing `firebase-service-account.json` (optional) |

## Deployment Steps

### 1. Register the server with mcp-key-service

The `plausible` connector ships in mcp-key-service (`src/connectors.ts`). Give this server a token:

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
sudo nano /opt/mcp-key-service/.env      # append ,plausible:<TOKEN> to INTERNAL_SERVER_TOKENS
cd /opt/mcp-key-service && docker compose up -d --force-recreate mcp-key-service
```

### 2. Prepare the checkout

```bash
sudo mkdir -p /opt/mcp-servers/plausibleanalytics
cd /opt/mcp-servers/plausibleanalytics
git clone https://github.com/hithereiamaliff/mcp-plausibleanalytics.git .
cp .env.sample .env && nano .env         # MCP_API_KEY, KEY_SERVICE_TOKEN, …
docker network inspect mcp-network >/dev/null 2>&1 || docker network create mcp-network
```

### 3. Start the container

```bash
docker compose up -d --build
docker compose logs -f --tail=50
```

### 4. Configure nginx

Add the `location /plausibleanalytics/` block from `deploy/nginx-mcp.conf` to the `mcp.techmavie.digital` server block, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5. GitHub Actions

Repository secrets: `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_PORT`. Every push to `main` (or a manual run) fetches + resets the checkout, rebuilds, and waits for `/health`. The workflow refuses to deploy if `.env` is missing.

## Verification Sequence

```bash
BASE=https://mcp.techmavie.digital/plausibleanalytics
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
H=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
```

1. Health — `keyService` should be `configured`:
   ```bash
   curl -s $BASE/health
   ```
2. Server card:
   ```bash
   curl -s $BASE/.well-known/mcp/server-card.json
   ```
3. Missing auth → `401 missing_auth`:
   ```bash
   curl -s -X POST $BASE/mcp "${H[@]}" -d "$LIST"
   ```
4. Invalid user key → `403 invalid_key`:
   ```bash
   curl -s -X POST $BASE/mcp/usr_00000000000000000000000000000000 "${H[@]}" -d "$LIST"
   ```
5. Hosted path mode (real key from the portal):
   ```bash
   curl -s -X POST $BASE/mcp/usr_YOUR_KEY "${H[@]}" -d "$LIST"
   ```
6. Hosted query mode:
   ```bash
   curl -s -X POST "$BASE/mcp?api_key=usr_YOUR_KEY" "${H[@]}" -d "$LIST"
   ```
7. Self-hosted header mode:
   ```bash
   curl -s -X POST $BASE/mcp "${H[@]}" -H "X-API-Key: $MCP_API_KEY" \
     -H "X-Plausible-Api-Key: YOUR_STATS_KEY" -H "X-Plausible-Url: https://plausible.example.com" -d "$LIST"
   ```
8. Real query through the hosted key:
   ```bash
   curl -s -X POST $BASE/mcp/usr_YOUR_KEY "${H[@]}" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_instance_info","arguments":{}}}'
   ```
9. Analytics protection — `401` without the key, `200` with it:
   ```bash
   curl -s $BASE/analytics
   curl -s $BASE/analytics -H "X-API-Key: $MCP_API_KEY"
   ```

## Useful Commands

```bash
docker compose ps
docker compose logs -f mcp-plausibleanalytics
docker compose restart mcp-plausibleanalytics
docker exec mcp-plausibleanalytics wget -qO- http://mcp-key-service:8090/health   # network check
```

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `503 service_unavailable` on hosted URLs | Key service unreachable or token rejected — check `KEY_SERVICE_URL` (must end in `/internal/resolve`), `KEY_SERVICE_TOKEN`, and that both containers are on `mcp-network` |
| `403 invalid_key` for a fresh key | Key revoked/suspended, or `plausible` missing from `INTERNAL_SERVER_TOKENS` (restart the key service after editing) |
| `400 invalid_config … private or internal address` | The instance URL resolves to a private IP. Use the public URL, or add the hostname to `ALLOW_PRIVATE_PLAUSIBLE_HOSTS` |
| Tool errors `401` from Plausible | Stats API key invalid, or the site belongs to a different team than the key |
| `list_goals` asks for a Plugin Token | Self-hosted CE has no Sites API — create a Plugin Token for the site and add `site=TOKEN` to the connection |
| Region / city breakdowns empty | CE default geo DB is country-level; configure `MAXMIND_LICENSE_KEY` or `IP_GEOLOCATION_DB` on Plausible |
| `405` on GET | Expected — the endpoint is stateless and only accepts POST |

# Plausible Analytics MCP Server

MCP (Model Context Protocol) server for [Plausible Analytics](https://plausible.io/), providing comprehensive access to the Stats API v2, Events API, and Sites API.

**MCP Endpoint:** `https://mcp.techmavie.digital/plausibleanalytics/mcp`

**Analytics Dashboard:** [`https://mcp.techmavie.digital/plausibleanalytics/analytics/dashboard`](https://mcp.techmavie.digital/plausibleanalytics/analytics/dashboard)

> This is a fork of the original [avimbu/plausible-model-context-protocol-server](https://github.com/avimbu/plausible-model-context-protocol-server), now maintained and significantly expanded by [@hithereiamaliff](https://github.com/hithereiamaliff).

## Features

- **Full Stats API v2 Coverage** - Query analytics with metrics, dimensions, filters, pagination, and time-series
- **Events API** - Record pageviews and custom events for server-side tracking
- **Sites API** - Manage sites, goals, shared links programmatically (Enterprise plan)
- **Real-time Visitors** - Get current visitor count on any site
- **Multi-Tenant Support** - Accepts Plausible API credentials via URL query parameters for shared deployments
- **Modern Transport** - Streamable HTTP transport for VPS hosting, plus STDIO for local clients
- **Firebase Analytics** - Cloud-based analytics storage with local file backup
- **VPS Deployment Ready** - Docker, Nginx, and GitHub Actions auto-deployment support

## Quick Start (Hosted Server)

The easiest way to use this MCP server is via the hosted endpoint. **No installation required!**

### MCP URL Format

```
https://mcp.techmavie.digital/plausibleanalytics/mcp?apiKey=YOUR_PLAUSIBLE_API_KEY
```

**Query Parameters:**

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `apiKey` | Yes | Your Plausible API key | `plaus_xxx...` |
| `apiUrl` | No | Plausible instance URL (default: `https://plausible.io`) | `https://plausible.example.com` |

### Client Configuration

For Claude Desktop / Cursor / Windsurf, add to your MCP configuration:

```json
{
  "mcpServers": {
    "plausible-analytics": {
      "transport": "streamable-http",
      "url": "https://mcp.techmavie.digital/plausibleanalytics/mcp?apiKey=YOUR_PLAUSIBLE_API_KEY"
    }
  }
}
```

### STDIO Mode (Local)

For local development with Claude Desktop:

```json
{
  "mcpServers": {
    "plausible-analytics": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "PLAUSIBLE_API_URL": "https://plausible.io",
        "PLAUSIBLE_API_KEY": "your_api_key"
      }
    }
  }
}
```

Or use npx (no installation required):

```json
{
  "mcpServers": {
    "plausible-analytics": {
      "command": "npx",
      "args": ["-y", "mcp-plausibleanalytics"],
      "env": {
        "PLAUSIBLE_API_KEY": "your_api_key"
      }
    }
  }
}
```

## Available Tools

### Stats API v2

| Tool | Description |
|------|-------------|
| `query_stats` | Full Stats API v2 query with metrics, dimensions, filters, ordering, and pagination |
| `get_realtime_visitors` | Get the current number of real-time visitors on a site |
| `get_aggregate_stats` | Simplified aggregate statistics (visitors, pageviews, bounce rate, etc.) |
| `get_timeseries` | Time-series data grouped by hour, day, week, or month |
| `get_breakdown` | Breakdown by dimension (top pages, traffic sources, countries, browsers, devices) |

### Events API

| Tool | Description |
|------|-------------|
| `send_event` | Record a custom event or pageview via the Events API |
| `send_pageview` | Simplified pageview recording |

### Sites API (Enterprise)

| Tool | Description |
|------|-------------|
| `list_sites` | List all sites in your Plausible account |
| `get_site` | Get site details and tracker configuration |
| `create_site` | Create a new site |
| `update_site` | Update site settings (e.g., change domain) |
| `delete_site` | Permanently delete a site and all its data |
| `create_shared_link` | Find or create a shared link for embedding dashboards |
| `list_goals` | List goals configured for a site |
| `create_goal` | Find or create a goal (custom event or page visit) |
| `delete_goal` | Delete a goal |

### Utility

| Tool | Description |
|------|-------------|
| `hello` | Test tool to verify the MCP server is working |
| `check_plausible_health` | Check if the Plausible API is healthy and accessible |

## Usage Examples

### Get a Site Overview

Ask your AI assistant:
> "Give me a summary of my analytics for example.com over the last 30 days"

The AI will use `get_aggregate_stats` with `date_range: "30d"`.

### Top Pages

> "What are the most visited pages on example.com this month?"

Uses `get_breakdown` with `dimension: "event:page"`.

### Traffic Sources

> "Where is my traffic coming from for example.com?"

Uses `get_breakdown` with `dimension: "visit:source"`.

### Real-time Visitors

> "How many people are on example.com right now?"

Uses `get_realtime_visitors`.

### Time-series Trends

> "Show me daily visitor trends for example.com over the last 7 days"

Uses `get_timeseries` with `interval: "day"` and `date_range: "7d"`.

### Track a Custom Event

> "Record a Signup event for example.com from https://example.com/register"

Uses `send_event` with `name: "Signup"`.

## Configuration

### Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `PLAUSIBLE_API_KEY` | Yes | Your Plausible API key | - |
| `PLAUSIBLE_API_URL` | No | Plausible instance URL | `https://plausible.io` |
| `PORT` | No | HTTP server port | `8080` |
| `HOST` | No | HTTP server host | `0.0.0.0` |

### API Keys

Plausible offers two types of API keys:

- **Stats API key** - For querying analytics data (Stats API tools). Available on all plans.
- **Sites API key** - For managing sites, goals, shared links (Sites API tools). Available on Enterprise plans.

Create your API key at: Plausible Dashboard > Settings > API Keys

## Self-Hosted (VPS) Deployment

### Architecture

```
Client (Claude, Cursor, Windsurf, etc.)
    ↓ HTTPS
https://mcp.techmavie.digital/plausibleanalytics/mcp
    ↓
Nginx (SSL termination + reverse proxy)
    ↓ HTTP
Docker Container (port 8087 → 8080)
    ↓
MCP Server (Streamable HTTP Transport)
    ↓
Plausible Analytics API
```

### Quick Deploy

```bash
# On your VPS
cd /opt/mcp-servers
git clone https://github.com/hithereiamaliff/mcp-plausibleanalytics.git plausibleanalytics
cd plausibleanalytics

# Optional: Create .env with default API key
echo "PLAUSIBLE_API_KEY=your_key_here" > .env

# Build and start
docker compose up -d --build

# Check logs
docker compose logs -f
```

### Deployment Files

| File | Description |
|------|-------------|
| `Dockerfile` | Container config with Node.js 20-alpine |
| `docker-compose.yml` | Docker orchestration with analytics volumes |
| `deploy/nginx-mcp.conf` | Nginx reverse proxy location block |
| `.github/workflows/deploy-vps.yml` | GitHub Actions auto-deployment |

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP endpoint (JSON-RPC) |
| `/analytics` | GET | Analytics JSON data |
| `/analytics/dashboard` | GET | Visual analytics dashboard (HTML) |
| `/analytics/tools` | GET | Tool usage statistics |
| `/analytics/import` | POST | Import backup analytics data |

### Auto-Deployment

Push to `main` branch triggers automatic deployment via GitHub Actions. Required secrets:

- `VPS_HOST` - VPS IP address
- `VPS_USERNAME` - SSH username
- `VPS_SSH_KEY` - Private SSH key
- `VPS_PORT` - SSH port

## Firebase Analytics

Cloud-based analytics persistence with local file backup as fallback.

### Setup

1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com/)
2. Enable Realtime Database
3. Generate service account credentials
4. Copy credentials to VPS:

```bash
mkdir -p /opt/mcp-servers/plausibleanalytics/.credentials
# Copy firebase-service-account.json to this directory
```

### Data Structure

```
mcp-analytics/
  └── mcp-plausibleanalytics/
      ├── serverStartTime
      ├── totalRequests
      ├── totalToolCalls
      ├── requestsByMethod
      ├── requestsByEndpoint
      ├── toolCalls
      ├── recentToolCalls
      ├── clientsByIp
      ├── clientsByUserAgent
      ├── hourlyRequests
      └── lastUpdated
```

## Local Development

```bash
# Install dependencies
npm install

# Run STDIO server in development mode
npm run dev

# Run HTTP server in development mode
npm run dev:http

# Build for production
npm run build

# Start production STDIO server
npm start

# Start production HTTP server
npm run start:http

# Test health endpoint
curl http://localhost:8080/health

# Test MCP endpoint
curl -X POST http://localhost:8080/mcp?apiKey=YOUR_KEY \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Project Structure

```
mcp-plausibleanalytics/
├── src/
│   ├── index.ts              # STDIO entry point (Smithery/local)
│   ├── http-server.ts        # HTTP server (VPS deployment)
│   ├── plausible-client.ts   # Plausible API client
│   ├── firebase-analytics.ts # Firebase analytics module
│   └── tools/
│       ├── stats.ts          # Stats API v2 tools
│       ├── events.ts         # Events API tools
│       └── sites.ts          # Sites API tools
├── deploy/
│   └── nginx-mcp.conf        # Nginx reverse proxy config
├── .github/
│   └── workflows/
│       └── deploy-vps.yml    # Auto-deployment workflow
├── Dockerfile                # Container config
├── docker-compose.yml        # Docker orchestration
├── package.json
├── tsconfig.json
├── smithery.yaml             # Smithery platform config
└── README.md
```

## Troubleshooting

### Connection Issues

```bash
# Test health endpoint
curl https://mcp.techmavie.digital/plausibleanalytics/health

# Test MCP endpoint (list tools)
curl -X POST "https://mcp.techmavie.digital/plausibleanalytics/mcp?apiKey=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Missing API key | No `apiKey` parameter provided | Add `?apiKey=YOUR_KEY` to the MCP URL |
| 401 Unauthorized | Invalid API key | Check your key at Plausible Dashboard > Settings > API Keys |
| 402 Payment Required | Sites API on non-Enterprise plan | Sites API tools require Enterprise plan |
| 429 Too Many Requests | Rate limit exceeded (600/hour) | Reduce request frequency |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Create a pull request

## License

[MIT](./LICENSE)

## Acknowledgments

- [Plausible Analytics](https://plausible.io/) for the privacy-friendly analytics platform
- [AVIMBU](https://avimbu.com/) for the original MCP server implementation
- [Model Context Protocol](https://modelcontextprotocol.io/) for the MCP framework

---

Made with care by [Aliff](https://mynameisaliff.co.uk/) (TechMavie Digital)
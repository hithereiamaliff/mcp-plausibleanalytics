#!/usr/bin/env node

/**
 * Plausible Analytics MCP Server - HTTP Server Entry Point
 * For self-hosting on VPS with nginx reverse proxy
 * Uses Streamable HTTP transport with Firebase Analytics
 */

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PlausibleClient } from './plausible-client.js';
import { registerStatsTools } from './tools/stats.js';
import { registerEventsTools } from './tools/events.js';
import { registerSitesTools } from './tools/sites.js';
import { FirebaseAnalytics, Analytics } from './firebase-analytics.js';

// Configuration
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ANALYTICS_DATA_DIR = process.env.ANALYTICS_DIR || '/app/data';
const ANALYTICS_FILE = path.join(ANALYTICS_DATA_DIR, 'analytics.json');
const SAVE_INTERVAL_MS = 60000; // Save every 60 seconds
const MAX_RECENT_CALLS = 100;

// Plausible API configuration - can be provided via query params or environment variables
const DEFAULT_PLAUSIBLE_API_URL = process.env.PLAUSIBLE_API_URL || 'https://plausible.io';
const DEFAULT_PLAUSIBLE_API_KEY = process.env.PLAUSIBLE_API_KEY || '';

// ============================================================================
// Firebase Analytics Setup
// ============================================================================
const firebaseAnalytics = new FirebaseAnalytics('mcp-plausibleanalytics');

// Sanitize Firebase keys - replace invalid characters
function sanitizeKey(key: string): string {
  return key.replace(/[.#$/\[\]]/g, '_');
}

function sanitizeObject(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const sanitizedKey = sanitizeKey(key);
    sanitized[sanitizedKey] = sanitizeObject(value);
  }
  return sanitized;
}

// ============================================================================
// Analytics Tracking
// ============================================================================
let analytics: Analytics = {
  serverStartTime: new Date().toISOString(),
  totalRequests: 0,
  totalToolCalls: 0,
  requestsByMethod: {},
  requestsByEndpoint: {},
  toolCalls: {},
  recentToolCalls: [],
  clientsByIp: {},
  clientsByUserAgent: {},
  hourlyRequests: {},
};

// ============================================================================
// Analytics Persistence - Dual Mode (Firebase + Local Backup)
// ============================================================================
function ensureDataDir(): void {
  if (!fs.existsSync(ANALYTICS_DATA_DIR)) {
    fs.mkdirSync(ANALYTICS_DATA_DIR, { recursive: true });
    console.log(`📁 Created analytics data directory: ${ANALYTICS_DATA_DIR}`);
  }
}

async function loadAnalytics(): Promise<void> {
  try {
    // Try Firebase first
    if (firebaseAnalytics.isInitialized()) {
      const firebaseData = await firebaseAnalytics.loadAnalytics();
      if (firebaseData) {
        analytics = firebaseData;
        console.log('📊 Loaded analytics from Firebase ✅');
        console.log(`   Total requests: ${analytics.totalRequests.toLocaleString()}, Tool calls: ${analytics.totalToolCalls}`);
        return;
      }
    }

    // Fallback to local file
    ensureDataDir();
    if (fs.existsSync(ANALYTICS_FILE)) {
      const data = fs.readFileSync(ANALYTICS_FILE, 'utf-8');
      const loaded = JSON.parse(data) as Analytics;
      analytics = {
        ...loaded,
        serverStartTime: loaded.serverStartTime || new Date().toISOString(),
      };
      console.log(`📊 Loaded analytics from local file`);
      console.log(`   Total requests: ${analytics.totalRequests.toLocaleString()}, Tool calls: ${analytics.totalToolCalls}`);
    } else {
      console.log(`📊 No existing analytics found, starting fresh`);
    }
  } catch (error) {
    console.error(`⚠️ Failed to load analytics:`, error);
    console.log(`📊 Starting with fresh analytics`);
  }
}

async function saveAnalytics(): Promise<void> {
  try {
    // Save to Firebase (primary)
    if (firebaseAnalytics.isInitialized()) {
      const sanitized = sanitizeObject(analytics) as Analytics;
      await firebaseAnalytics.saveAnalytics(sanitized);
    }

    // Also save locally as backup
    ensureDataDir();
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2));

    const storage = firebaseAnalytics.isInitialized() ? 'Firebase + local backup' : 'local file only';
    console.log(`💾 Saved analytics to ${storage}`);
  } catch (error) {
    console.error(`⚠️ Failed to save analytics:`, error);
  }
}

// Load analytics on startup
(async () => {
  await loadAnalytics();
})();

// Periodic save
const saveInterval = setInterval(() => {
  saveAnalytics();
}, SAVE_INTERVAL_MS);

function trackRequest(req: Request, endpoint: string): void {
  analytics.totalRequests++;

  const method = req.method;
  analytics.requestsByMethod[method] = (analytics.requestsByMethod[method] || 0) + 1;

  analytics.requestsByEndpoint[endpoint] = (analytics.requestsByEndpoint[endpoint] || 0) + 1;

  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
  analytics.clientsByIp[clientIp] = (analytics.clientsByIp[clientIp] || 0) + 1;

  const userAgent = req.headers['user-agent'] || 'unknown';
  const shortAgent = userAgent.substring(0, 50);
  analytics.clientsByUserAgent[shortAgent] = (analytics.clientsByUserAgent[shortAgent] || 0) + 1;

  const hour = new Date().toISOString().substring(0, 13);
  analytics.hourlyRequests[hour] = (analytics.hourlyRequests[hour] || 0) + 1;
}

function trackToolCall(toolName: string, req: Request): void {
  analytics.totalToolCalls++;
  analytics.toolCalls[toolName] = (analytics.toolCalls[toolName] || 0) + 1;

  const toolCall = {
    tool: toolName,
    timestamp: new Date().toISOString(),
    clientIp: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown',
    userAgent: (req.headers['user-agent'] || 'unknown').substring(0, 50),
  };

  analytics.recentToolCalls.unshift(toolCall);
  if (analytics.recentToolCalls.length > MAX_RECENT_CALLS) {
    analytics.recentToolCalls.pop();
  }
}

function getUptime(): string {
  const start = new Date(analytics.serverStartTime).getTime();
  const now = Date.now();
  const diff = now - start;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ============================================================================
// MCP Server Setup
// ============================================================================

function createMcpServer(apiUrl: string, apiKey: string): McpServer {
  const client = new PlausibleClient({ apiUrl, apiKey });
  const getClient = () => client;

  const server = new McpServer({
    name: 'Plausible Analytics MCP Server',
    version: '1.0.0',
  });

  // Register all tools
  registerStatsTools(server, getClient);
  registerEventsTools(server, getClient);
  registerSitesTools(server, getClient);

  // Hello tool for testing
  server.tool(
    'hello',
    'A simple test tool to verify that the Plausible Analytics MCP server is working correctly',
    {},
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: 'Hello from Plausible Analytics MCP!',
              timestamp: new Date().toISOString(),
              apiUrl,
              transport: 'streamable-http',
              firebase: firebaseAnalytics.isInitialized() ? 'enabled' : 'disabled',
            }, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

// ============================================================================
// Express App
// ============================================================================
const app = express();
app.use(express.json());

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'Accept-Encoding',
    'Cache-Control',
    'Connection',
    'User-Agent',
    'X-Requested-With',
    'X-Plausible-Api-Key',
    'X-Plausible-Api-Url',
    'Mcp-Session-Id',
  ],
  exposedHeaders: ['Content-Type', 'Cache-Control', 'Mcp-Session-Id'],
  credentials: false,
  maxAge: 86400,
}));

app.options('*', cors());

// Store MCP servers per credentials (reused across requests)
const mcpServers = new Map<string, McpServer>();

// ============================================================================
// Endpoints
// ============================================================================

// Root - server info
app.get('/', (req: Request, res: Response) => {
  trackRequest(req, '/');
  res.json({
    name: 'Plausible Analytics MCP Server',
    version: '1.0.0',
    description: 'MCP server for Plausible Analytics - Stats API, Events API, and Sites API',
    transport: 'streamable-http',
    firebase: firebaseAnalytics.isInitialized() ? 'enabled' : 'disabled',
    endpoints: {
      mcp: '/mcp',
      health: '/health',
      analytics: '/analytics',
      analyticsDashboard: '/analytics/dashboard',
    },
    documentation: 'https://github.com/hithereiamaliff/mcp-plausibleanalytics',
  });
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  trackRequest(req, '/health');
  res.json({
    status: 'healthy',
    server: 'Plausible Analytics MCP Server',
    version: '1.0.0',
    transport: 'streamable-http',
    firebase: firebaseAnalytics.isInitialized() ? 'connected' : 'disabled',
    timestamp: new Date().toISOString(),
  });
});

// Analytics endpoint - JSON summary
app.get('/analytics', (req: Request, res: Response) => {
  trackRequest(req, '/analytics');

  const sortedTools = Object.entries(analytics.toolCalls)
    .sort(([, a], [, b]) => b - a)
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {} as Record<string, number>);

  const sortedClients = Object.entries(analytics.clientsByIp)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {} as Record<string, number>);

  const last24Hours = Object.entries(analytics.hourlyRequests)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 24)
    .reverse()
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {} as Record<string, number>);

  res.json({
    server: 'Plausible Analytics MCP Server',
    uptime: getUptime(),
    serverStartTime: analytics.serverStartTime,
    firebase: firebaseAnalytics.isInitialized() ? 'enabled' : 'disabled',
    summary: {
      totalRequests: analytics.totalRequests,
      totalToolCalls: analytics.totalToolCalls,
      uniqueClients: Object.keys(analytics.clientsByIp).length,
    },
    breakdown: {
      byMethod: analytics.requestsByMethod,
      byEndpoint: analytics.requestsByEndpoint,
      byTool: sortedTools,
    },
    hourlyRequests: last24Hours,
    clients: {
      byIp: sortedClients,
      byUserAgent: analytics.clientsByUserAgent,
    },
    recentToolCalls: analytics.recentToolCalls.slice(0, 20),
  });
});

// Analytics endpoint - tool usage stats
app.get('/analytics/tools', (req: Request, res: Response) => {
  trackRequest(req, '/analytics/tools');

  const sortedTools = Object.entries(analytics.toolCalls)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => ({ name, count, percentage: analytics.totalToolCalls > 0 ? ((count / analytics.totalToolCalls) * 100).toFixed(1) + '%' : '0%' }));

  res.json({
    totalToolCalls: analytics.totalToolCalls,
    tools: sortedTools,
    recentCalls: analytics.recentToolCalls.slice(0, 50),
  });
});

// Analytics import endpoint
app.post('/analytics/import', (req: Request, res: Response) => {
  trackRequest(req, '/analytics/import');
  try {
    const importData = req.body;
    if (importData.totalRequests) {
      analytics.totalRequests += importData.totalRequests;
    }
    if (importData.totalToolCalls) {
      analytics.totalToolCalls += importData.totalToolCalls;
    }
    saveAnalytics();
    res.json({
      message: 'Analytics imported successfully',
      currentStats: {
        totalRequests: analytics.totalRequests,
        totalToolCalls: analytics.totalToolCalls,
      },
    });
  } catch (error) {
    res.status(400).json({ error: 'Failed to import analytics', details: String(error) });
  }
});

// Analytics dashboard - HTML page with Chart.js
app.get('/analytics/dashboard', (req: Request, res: Response) => {
  trackRequest(req, '/analytics/dashboard');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Plausible Analytics MCP - Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e4e4e7; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .header h1 { font-size: 1.8rem; color: #a78bfa; }
    .header p { color: #71717a; margin-top: 5px; font-size: 0.9rem; }
    .firebase-badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; margin-left: 8px; }
    .firebase-enabled { background: rgba(34,197,94,0.2); color: #22c55e; }
    .firebase-disabled { background: rgba(234,179,8,0.2); color: #eab308; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; padding: 20px; text-align: center; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #a78bfa; }
    .stat-label { color: #71717a; font-size: 0.85rem; margin-top: 5px; }
    .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .chart-card { background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; padding: 20px; }
    .chart-card h3 { color: #a1a1aa; font-size: 0.9rem; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.05em; }
    .chart-container { position: relative; height: 250px; }
    .recent-calls { background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; padding: 20px; margin-bottom: 30px; }
    .recent-calls h3 { color: #a1a1aa; font-size: 0.9rem; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.05em; }
    .call-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #27272a; }
    .call-item:last-child { border-bottom: none; }
    .call-tool { color: #a78bfa; font-weight: 600; font-size: 0.9rem; }
    .call-client { color: #71717a; font-size: 0.75rem; margin-top: 2px; }
    .call-time { color: #52525b; font-size: 0.8rem; }
    .refresh-btn { position: fixed; bottom: 20px; right: 20px; background: #a78bfa; color: white; border: none; border-radius: 50%; width: 50px; height: 50px; cursor: pointer; font-size: 1.2rem; box-shadow: 0 4px 12px rgba(167,139,250,0.3); }
    .refresh-btn:hover { background: #8b5cf6; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Plausible Analytics MCP Dashboard</h1>
    <p id="uptime">Loading...</p>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value" id="totalRequests">-</div>
      <div class="stat-label">Total Requests</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="totalToolCalls">-</div>
      <div class="stat-label">Tool Calls</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="uniqueClients">-</div>
      <div class="stat-label">Unique Clients</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="topTool">-</div>
      <div class="stat-label">Top Tool</div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <h3>Tool Usage Distribution</h3>
      <div class="chart-container"><canvas id="toolsChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Hourly Requests (Last 24h)</h3>
      <div class="chart-container"><canvas id="hourlyChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Requests by Endpoint</h3>
      <div class="chart-container"><canvas id="endpointChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Top Clients by User Agent</h3>
      <div class="chart-container"><canvas id="clientsChart"></canvas></div>
    </div>
  </div>

  <div class="recent-calls">
    <h3>Recent Tool Calls</h3>
    <div id="recentCalls"><p style="color: #71717a;">Loading...</p></div>
  </div>

  <button class="refresh-btn" onclick="loadData()">&#x1f504;</button>

  <script>
    let toolsChart, hourlyChart, endpointChart, clientsChart;
    const chartColors = ['#a78bfa','#3b82f6','#ec4899','#f59e0b','#10b981','#06b6d4','#f43f5e','#84cc16','#6366f1','#14b8a6'];

    async function loadData() {
      try {
        const basePath = window.location.pathname.replace(/\\/analytics\\/dashboard\\/?$/, '');
        const res = await fetch(basePath + '/analytics');
        const data = await res.json();
        updateDashboard(data);
      } catch (err) {
        console.error('Failed to load analytics:', err);
      }
    }

    function updateDashboard(data) {
      document.getElementById('totalRequests').textContent = data.summary.totalRequests.toLocaleString();
      document.getElementById('totalToolCalls').textContent = data.summary.totalToolCalls.toLocaleString();
      document.getElementById('uniqueClients').textContent = data.summary.uniqueClients.toLocaleString();

      const firebaseBadge = data.firebase === 'enabled'
        ? '<span class="firebase-badge firebase-enabled">Firebase</span>'
        : '<span class="firebase-badge firebase-disabled">Local Only</span>';
      document.getElementById('uptime').innerHTML = 'Uptime: ' + data.uptime + ' ' + firebaseBadge;

      const tools = Object.entries(data.breakdown.byTool);
      if (tools.length > 0) {
        const topTool = tools.sort((a, b) => b[1] - a[1])[0][0];
        document.getElementById('topTool').textContent = topTool.substring(0, 14);
      }

      updateToolsChart(data.breakdown.byTool);
      updateHourlyChart(data.hourlyRequests);
      updateEndpointChart(data.breakdown.byEndpoint);
      updateClientsChart(data.clients.byUserAgent);
      updateRecentCalls(data.recentToolCalls);
    }

    function updateToolsChart(toolData) {
      const labels = Object.keys(toolData).slice(0, 10);
      const values = Object.values(toolData).slice(0, 10);
      if (toolsChart) toolsChart.destroy();
      toolsChart = new Chart(document.getElementById('toolsChart'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: chartColors, borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#a1a1aa', font: { size: 11 } } } } }
      });
    }

    function updateHourlyChart(hourlyData) {
      const labels = Object.keys(hourlyData).map(h => h.split('T')[1] + ':00');
      const values = Object.values(hourlyData);
      if (hourlyChart) hourlyChart.destroy();
      hourlyChart = new Chart(document.getElementById('hourlyChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Requests', data: values, borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.1)', fill: true, tension: 0.4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true } } }
      });
    }

    function updateEndpointChart(endpointData) {
      const labels = Object.keys(endpointData);
      const values = Object.values(endpointData);
      if (endpointChart) endpointChart.destroy();
      endpointChart = new Chart(document.getElementById('endpointChart'), {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: chartColors, borderRadius: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#71717a' }, grid: { display: false } }, y: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true } } }
      });
    }

    function updateClientsChart(clientData) {
      const entries = Object.entries(clientData).slice(0, 5);
      const labels = entries.map(([k]) => k.substring(0, 30) + (k.length > 30 ? '...' : ''));
      const values = entries.map(([, v]) => v);
      if (clientsChart) clientsChart.destroy();
      clientsChart = new Chart(document.getElementById('clientsChart'), {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: chartColors.slice(0, 5), borderRadius: 8 }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }, y: { ticks: { color: '#71717a', font: { size: 10 } }, grid: { display: false } } } }
      });
    }

    function updateRecentCalls(calls) {
      const container = document.getElementById('recentCalls');
      if (!calls || calls.length === 0) {
        container.innerHTML = '<p style="color: #71717a;">No tool calls yet</p>';
        return;
      }
      container.innerHTML = calls.slice(0, 20).map(call =>
        '<div class="call-item"><div><span class="call-tool">' + call.tool + '</span><div class="call-client">' + call.userAgent + '</div></div><span class="call-time">' + new Date(call.timestamp).toLocaleTimeString() + '</span></div>'
      ).join('');
    }

    loadData();
    setInterval(loadData, 30000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ============================================================================
// MCP Endpoint
// ============================================================================
app.all('/mcp', async (req: Request, res: Response) => {
  // Fix Accept header for MCP SDK compatibility
  const acceptHeader = req.headers['accept'] || '';
  if (!acceptHeader.includes('text/event-stream')) {
    req.headers['accept'] = acceptHeader ? `${acceptHeader}, text/event-stream` : 'text/event-stream';
  }

  trackRequest(req, '/mcp');

  // Track tool calls
  if (req.body && req.body.method === 'tools/call' && req.body.params?.name) {
    trackToolCall(req.body.params.name, req);
  }

  try {
    // Extract Plausible credentials from query params, headers, or environment
    const apiKey = (req.query.apiKey as string)
      || (req.headers['x-plausible-api-key'] as string)
      || DEFAULT_PLAUSIBLE_API_KEY;

    const apiUrl = (req.query.apiUrl as string)
      || (req.headers['x-plausible-api-url'] as string)
      || DEFAULT_PLAUSIBLE_API_URL;

    // Handle discovery requests without credentials (for Smithery scanning)
    const hasCredentials = apiKey && apiKey.length > 0;
    const mcpMethod = req.body?.method;
    const isDiscoveryRequest = !hasCredentials && mcpMethod && (
      mcpMethod === 'initialize' ||
      mcpMethod === 'tools/list' ||
      mcpMethod === 'notifications/initialized'
    );

    if (isDiscoveryRequest) {
      // Create a demo MCP server for discovery (no real API connection)
      const demoServer = createMcpServer(apiUrl, 'demo-key');

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on('close', () => {
        transport.close();
      });

      await demoServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Validate credentials for actual requests
    if (!apiKey) {
      res.status(400).json({
        error: 'Missing Plausible API key',
        message: 'Provide your API key via query parameter (?apiKey=YOUR_KEY), header (X-Plausible-Api-Key), or environment variable (PLAUSIBLE_API_KEY)',
        example: '/mcp?apiKey=YOUR_PLAUSIBLE_API_KEY',
      });
      return;
    }

    // Get or create MCP server for these credentials
    const credentialsKey = `${apiUrl}:${apiKey.substring(0, 8)}`;
    let mcpServer = mcpServers.get(credentialsKey);
    if (!mcpServer) {
      mcpServer = createMcpServer(apiUrl, apiKey);
      mcpServers.set(credentialsKey, mcpServer);
    }

    // Create a NEW transport for EACH request (stateless mode)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// ============================================================================
// Graceful Shutdown
// ============================================================================
async function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  clearInterval(saveInterval);
  await saveAnalytics();
  console.log('Analytics saved. Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================================
// Start Server
// ============================================================================
app.listen(PORT, HOST, () => {
  console.log('='.repeat(60));
  console.log('  Plausible Analytics MCP Server (Streamable HTTP)');
  console.log('='.repeat(60));
  console.log(`  Server running on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint: http://${HOST}:${PORT}/mcp`);
  console.log(`  Health check: http://${HOST}:${PORT}/health`);
  console.log(`  Analytics: http://${HOST}:${PORT}/analytics`);
  console.log(`  Dashboard: http://${HOST}:${PORT}/analytics/dashboard`);
  console.log(`  Firebase: ${firebaseAnalytics.isInitialized() ? 'Enabled' : 'Disabled'}`);
  console.log(`  Default API URL: ${DEFAULT_PLAUSIBLE_API_URL}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('Test with MCP Inspector:');
  console.log(`  npx @modelcontextprotocol/inspector`);
  console.log(`  Select "Streamable HTTP" and enter: http://localhost:${PORT}/mcp?apiKey=YOUR_KEY`);
  console.log('');
});

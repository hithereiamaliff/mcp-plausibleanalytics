#!/usr/bin/env node
/**
 * End-to-end smoke test (no real credentials needed).
 *
 * Boots dist/http-server.js against a fake MCP Key Service and a fake Plausible instance,
 * then drives it with the official MCP SDK client in every auth mode, plus dist/cli.js
 * over stdio. Run with: npm run smoke
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAUSIBLE_KEY = 'plausible-key';
const PLUGIN_TOKEN = 'plugin-token';
const SERVER_TOKEN = 'server-token';
const ADMIN_KEY = 'admin-key';

const KEYS = {
  readOnly: `usr_${'a'.repeat(32)}`,
  invalid: `usr_${'b'.repeat(32)}`,
  writes: `usr_${'c'.repeat(32)}`,
  privateUrl: `usr_${'d'.repeat(32)}`,
  uncached: `usr_${'e'.repeat(32)}`,
};

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

// =============================================================================
// Fake Plausible
// =============================================================================

const plausibleRequests = [];

const DIMENSION_VALUES = {
  'event:page': ['/', '/blog', '/pricing'],
  'visit:source': ['Google', 'Direct / None', 'Twitter'],
  'visit:country_name': ['Malaysia', 'Singapore', 'Germany'],
  'visit:device': ['Desktop', 'Mobile', 'Tablet'],
  'event:goal': ['Signup', 'Visit /pricing'],
};

function resolveRange(range) {
  if (typeof range === 'string') return ['2026-10-01T00:00:00+08:00', '2026-10-07T23:59:59+08:00'];
  const [start, end] = range;
  return start.length === 10 ? [`${start}T00:00:00+08:00`, `${end}T23:59:59+08:00`] : [start, end];
}

// Plausible's session/event conflict rule (lib/plausible/stats/table_decider.ex)
const SESSION_METRICS = ['bounce_rate', 'visit_duration', 'views_per_visit'];
const EVENT_METRICS = ['pageviews', 'events', 'scroll_depth', 'time_on_page', 'total_revenue', 'average_revenue'];
const SESSION_DIMENSIONS = ['visit:entry_page', 'visit:exit_page', 'visit:entry_page_hostname', 'visit:exit_page_hostname'];

function conflictError(body) {
  const dims = body.dimensions ?? [];
  const eventDims = dims.filter(d => d.startsWith('event:'));
  const sessionDims = dims.filter(d => SESSION_DIMENSIONS.includes(d));
  const sessionMetrics = body.metrics.filter(m => SESSION_METRICS.includes(m));
  const eventMetrics = body.metrics.filter(m => EVENT_METRICS.includes(m));
  if (eventDims.length === 1 && eventDims[0] === 'event:page' && dims.length === 1) return undefined;
  if (sessionMetrics.length && eventDims.length) return `Session metric(s) ${sessionMetrics} cannot be queried along with event dimension(s) ${eventDims}`;
  if (eventMetrics.length && sessionDims.length) return `Event metric(s) ${eventMetrics} cannot be queried along with session dimension(s) ${sessionDims}`;
  return undefined;
}

function fakeQuery(body) {
  const resolved = resolveRange(body.date_range);
  const previous = resolved[0].startsWith('2026-09');
  const scale = previous ? 0.5 : 1;
  const dims = body.dimensions ?? [];
  const metricsFor = seed => body.metrics.map((metric, index) => (metric === 'bounce_rate' ? 40 + index : Math.round((100 + seed * 10 + index) * scale)));

  let results;
  const meta = {};
  if (dims.length === 0) {
    results = [{ dimensions: [], metrics: metricsFor(0) }];
  } else if (dims[0].startsWith('time')) {
    const labels = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
    results = ['2026-10-02', '2026-10-04', '2026-10-06'].map((label, i) => ({ dimensions: [label], metrics: metricsFor(i) }));
    if (body.include?.time_labels) meta.time_labels = labels;
  } else {
    let values = DIMENSION_VALUES[dims[0]] ?? ['a', 'b', 'c'];
    const dimFilter = (body.filters ?? []).find(filter => filter[0] === 'is' && filter[1] === dims[0]);
    if (dimFilter) values = values.filter(value => dimFilter[2].includes(value));
    results = values.map((value, i) => ({ dimensions: [value, ...dims.slice(1).map(() => 'x')], metrics: metricsFor(3 - i) }));
  }
  if (body.include?.total_rows) meta.total_rows = results.length + 10;

  return { results, meta, query: { ...body, date_range: resolved } };
}

const plausible = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake');
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : undefined;
  plausibleRequests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization });

  const bearerOk = req.headers.authorization === `Bearer ${PLAUSIBLE_KEY}`;
  const basicOk = req.headers.authorization === `Basic ${Buffer.from(`example.com:${PLUGIN_TOKEN}`).toString('base64')}`;

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/system':
      return json(res, 200, { build: { version: 'v3.2.1' }, geo_database: 'DBIP-Country-Lite' });
    case 'GET /api/health':
      // CE < 3.0 only serves the legacy health endpoint
      return json(res, 200, { postgres: 'ok', clickhouse: 'ok' });
    case 'GET /api/docs/query/schema.json':
      return json(res, 200, {
        definitions: {
          metric: { oneOf: ['visitors', 'visits', 'pageviews', 'bounce_rate'].map(c => ({ const: c })) },
          date_range_shorthand: { anyOf: [{ const: 'day' }, { const: '7d' }, { const: '30d' }, { pattern: '^\\d+d$', type: 'string' }] },
        },
        properties: { include: { properties: { imports: {}, time_labels: {}, total_rows: {}, trim_relative_date_range: {} } } },
      });
    case 'POST /api/v2/query':
      if (!bearerOk) return json(res, 401, { error: 'Invalid API key or site ID.' });
      if (conflictError(body)) return json(res, 400, { error: conflictError(body) });
      return json(res, 200, fakeQuery(body));
    case 'GET /api/v1/stats/realtime/visitors':
      if (!bearerOk) return json(res, 401, { error: 'Invalid API key or site ID.' });
      return json(res, 200, 7);
    case 'GET /api/plugins/v1/capabilities':
      return json(res, 200, { authorized: basicOk, data_domain: basicOk ? 'example.com' : null, features: {} });
    case 'GET /api/plugins/v1/goals':
      if (!basicOk) return json(res, 401, { errors: [{ detail: 'Plugins API: unauthorized' }] });
      return json(res, 200, {
        goals: [
          { goal_type: 'Goal.CustomEvent', goal: { id: 1, display_name: 'Signup', event_name: 'Signup' } },
          { goal_type: 'Goal.Pageview', goal: { id: 2, display_name: 'Visit /pricing', path: '/pricing' } },
        ],
        meta: { pagination: { has_next_page: false, has_prev_page: false } },
      });
    case 'PUT /api/plugins/v1/goals':
      if (!basicOk) return json(res, 401, { errors: [{ detail: 'Plugins API: unauthorized' }] });
      return json(res, 201, { goals: [{ goal_type: body.goal_type, goal: { id: 3, display_name: body.goal.event_name ?? `Visit ${body.goal.path}`, ...body.goal } }] });
    case 'GET /api/plugins/v1/shared_links':
      return json(res, 200, { shared_links: [{ shared_link: { id: 9, name: 'Public', password_protected: false, href: 'http://fake/share/example.com?auth=x' } }], meta: { pagination: {} } });
    case 'POST /api/event':
      res.writeHead(202, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    default:
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>Not Found</html>');
  }
});

// =============================================================================
// Fake MCP Key Service
// =============================================================================

let plausibleUrl;
const keyServiceRequests = [];

const keyService = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || '{}');
  keyServiceRequests.push(body);
  if (req.headers.authorization !== `Bearer ${SERVER_TOKEN}`) return json(res, 403, { valid: false, error: 'Unauthorized' });

  const credentials = {
    [KEYS.readOnly]: { plausible_url: plausibleUrl, plausible_api_key: PLAUSIBLE_KEY, plausible_sites: 'example.com, blog.example.com', plausible_plugin_tokens: `example.com=${PLUGIN_TOKEN}` },
    [KEYS.writes]: { plausible_url: plausibleUrl, plausible_api_key: PLAUSIBLE_KEY, plausible_sites: 'example.com', plausible_plugin_tokens: `example.com=${PLUGIN_TOKEN}`, plausible_allow_writes: 'yes' },
    [KEYS.privateUrl]: { plausible_url: 'http://10.0.0.1:8000', plausible_api_key: PLAUSIBLE_KEY },
    [KEYS.uncached]: { plausible_url: plausibleUrl, plausible_api_key: PLAUSIBLE_KEY },
  }[body.key];

  if (!credentials) return json(res, 401, { valid: false, error: 'Invalid, revoked, or suspended API key, or server not authorized' });
  return json(res, 200, { valid: true, credentials, label: 'test', connector_id: 'plausible' });
});

// =============================================================================
// Run
// =============================================================================

const plausiblePort = await listen(plausible);
const keyServicePort = await listen(keyService);
plausibleUrl = `http://127.0.0.1:${plausiblePort}`;

const probe = http.createServer();
const mcpPort = await listen(probe);
await new Promise(resolve => probe.close(resolve));

const analyticsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plausible-mcp-smoke-'));
const serverProcess = spawn(process.execPath, [path.join(ROOT, 'dist/http-server.js')], {
  env: {
    ...process.env,
    PORT: String(mcpPort),
    HOST: '127.0.0.1',
    MCP_API_KEY: ADMIN_KEY,
    KEY_SERVICE_URL: `http://127.0.0.1:${keyServicePort}/internal/resolve`,
    KEY_SERVICE_TOKEN: SERVER_TOKEN,
    ALLOW_PRIVATE_PLAUSIBLE_HOSTS: '127.0.0.1',
    ANALYTICS_DIR: analyticsDir,
    FIREBASE_SERVICE_ACCOUNT_PATH: path.join(analyticsDir, 'missing.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
serverProcess.stdout.on('data', chunk => (serverLog += chunk));
serverProcess.stderr.on('data', chunk => (serverLog += chunk));

const mcpBase = `http://127.0.0.1:${mcpPort}`;

async function shutdown(code) {
  serverProcess.kill();
  plausible.close();
  keyService.close();
  fs.rmSync(analyticsDir, { recursive: true, force: true });
  process.exit(code);
}

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${mcpBase}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy.\n${serverLog}`);
}

async function connect(url, headers) {
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
  return client;
}

const text = result => result.content.map(item => item.text).join('\n');

async function rawPost(url, headers = {}, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

try {
  await waitForHealth();

  console.log('\nHosted key-service mode (path), read-only connection');
  const hosted = await connect(`${mcpBase}/mcp/${KEYS.readOnly}`);
  const tools = (await hosted.listTools()).tools.map(tool => tool.name);

  await check('read tools registered, write / cloud tools hidden', () => {
    for (const name of ['hello', 'get_instance_info', 'list_sites', 'get_site_overview', 'get_breakdown', 'compare_periods', 'query_stats', 'list_goals', 'list_shared_links']) {
      assert.ok(tools.includes(name), `missing ${name}`);
    }
    for (const name of ['create_goal', 'delete_goal', 'send_event', 'get_site', 'create_site']) {
      assert.ok(!tools.includes(name), `should not expose ${name}`);
    }
  });

  await check('read tools carry readOnlyHint', async () => {
    const overview = (await hosted.listTools()).tools.find(tool => tool.name === 'get_site_overview');
    assert.equal(overview.annotations.readOnlyHint, true);
  });

  await check('get_site_overview uses the default site and compares periods', async () => {
    plausibleRequests.length = 0;
    const result = await hosted.callTool({ name: 'get_site_overview', arguments: { date_range: '7d' } });
    const output = text(result);
    assert.ok(!result.isError, output);
    assert.match(output, /Site overview — example\.com/);
    assert.match(output, /compared with 2026-09-24 → 2026-09-30/);
    assert.match(output, /\| visitors \| 100 \| 50 \| \+100% \|/);
    assert.match(output, /### Top pages/);
    assert.ok(plausibleRequests.some(r => r.path === '/api/v2/query' && JSON.stringify(r.body.date_range) === '["2026-09-24","2026-09-30"]'));
  });

  await check('get_breakdown resolves aliases and paginates', async () => {
    const output = text(await hosted.callTool({ name: 'get_breakdown', arguments: { dimension: 'country', filters: [{ dimension: 'device', values: ['Mobile'] }] } }));
    assert.match(output, /\| country \| visitors \| visits \| bounce_rate \| visit_duration \|/);
    assert.match(output, /Malaysia/);
    assert.match(output, /offset=3/);
    const last = plausibleRequests.at(-1);
    assert.deepEqual(last.body.dimensions, ['visit:country_name']);
    assert.deepEqual(last.body.filters, [['is', 'visit:device', ['Mobile']]]);
  });

  await check('default breakdown metrics respect session/event rules', async () => {
    const hostname = await hosted.callTool({ name: 'get_breakdown', arguments: { dimension: 'hostname' } });
    assert.ok(!hostname.isError, text(hostname));
    const pageAndHost = await hosted.callTool({ name: 'get_breakdown', arguments: { dimension: ['page', 'hostname'] } });
    assert.ok(!pageAndHost.isError, text(pageAndHost));
    const landing = await hosted.callTool({ name: 'get_goal_conversions', arguments: { breakdown_by: 'entry_page' } });
    assert.ok(!landing.isError, text(landing));
    assert.match(text(landing), /group_conversion_rate/);
  });

  await check('get_timeseries zero-fills empty buckets', async () => {
    const output = text(await hosted.callTool({ name: 'get_timeseries', arguments: { interval: 'day', format: 'json' } }));
    assert.equal(JSON.parse(output).rows.length, 7);
  });

  await check('compare_periods by dimension filters the previous period to the current rows', async () => {
    const output = text(await hosted.callTool({ name: 'compare_periods', arguments: { dimension: 'page', date_range: '7d' } }));
    assert.match(output, /Compare periods by page/);
    assert.match(output, /previous_visitors/);
    const previous = plausibleRequests.at(-1);
    assert.deepEqual(previous.body.filters.at(-1), ['is', 'event:page', ['/', '/blog', '/pricing']]);
  });

  await check('get_goal_conversions and get_realtime_visitors', async () => {
    assert.match(text(await hosted.callTool({ name: 'get_goal_conversions', arguments: {} })), /Signup/);
    assert.match(text(await hosted.callTool({ name: 'get_realtime_visitors', arguments: {} })), /\*\*7\*\* current visitors/);
  });

  await check('query_stats maps aliases inside raw filter trees', async () => {
    const output = text(await hosted.callTool({
      name: 'query_stats',
      arguments: { metrics: ['visitors'], dimensions: ['source'], filters: [['or', [['is', 'country', ['Malaysia']], ['contains', 'page', ['/blog']]]]], format: 'json' },
    }));
    assert.equal(JSON.parse(output).rows[0].source, 'Google');
    assert.deepEqual(plausibleRequests.at(-1).body.filters, [['or', [['is', 'visit:country_name', ['Malaysia']], ['contains', 'event:page', ['/blog']]]]]);
  });

  await check('list_sites returns configured sites on self-hosted', async () => {
    const output = text(await hosted.callTool({ name: 'list_sites', arguments: {} }));
    assert.match(output, /example\.com \| yes \| yes/);
    assert.match(output, /blog\.example\.com/);
  });

  await check('get_instance_info reports version, token validity and geo note', async () => {
    const output = text(await hosted.callTool({ name: 'get_instance_info', arguments: {} }));
    assert.match(output, /Community Edition v3\.2\.1/);
    assert.match(output, /example\.com: valid/);
    assert.match(output, /country level/);
    assert.match(output, /Health: \{"postgres":"ok"/, 'falls back to /api/health');
  });

  await check('list_goals uses the Plugins API with Basic auth', async () => {
    const output = text(await hosted.callTool({ name: 'list_goals', arguments: {} }));
    assert.match(output, /\| 2 \| page \| Visit \/pricing \| \/pricing \|/);
  });

  await check('management on a site without a plugin token explains how to add one', async () => {
    const result = await hosted.callTool({ name: 'list_goals', arguments: { site_id: 'blog.example.com' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /new_token=MCP/);
  });

  await check('tool input errors come back as isError results', async () => {
    const result = await hosted.callTool({ name: 'get_breakdown', arguments: { dimension: 'nonsense' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown dimension/);
  });
  await hosted.close();

  console.log('\nHosted key-service mode (query), writes allowed');
  const writer = await connect(`${mcpBase}/mcp?api_key=${KEYS.writes}`);
  const writerTools = (await writer.listTools()).tools;

  await check('write tools registered with the right annotations', () => {
    const byName = Object.fromEntries(writerTools.map(tool => [tool.name, tool]));
    for (const name of ['create_goal', 'delete_goal', 'create_shared_link', 'enable_custom_property', 'update_tracker_config', 'send_event']) {
      assert.ok(byName[name], `missing ${name}`);
    }
    assert.equal(byName.delete_goal.annotations.destructiveHint, true);
    assert.equal(byName.create_goal.annotations.idempotentHint, true);
  });

  await check('destructive tools require confirm: true', async () => {
    const result = await writer.callTool({ name: 'delete_goal', arguments: { goal_id: 1 } });
    assert.equal(result.isError, true);
    assert.match(text(result), /confirm: true/);
  });

  await check('create_goal and send_event', async () => {
    assert.match(text(await writer.callTool({ name: 'create_goal', arguments: { goal_type: 'event', event_name: 'Signup' } })), /Goal ready/);
    assert.match(text(await writer.callTool({ name: 'send_event', arguments: { name: 'Signup', url: 'https://example.com/register' } })), /Recorded "Signup"/);
  });
  await writer.close();

  console.log('\nSelf-hosted header mode');
  await check('X-API-Key + X-Plausible-* headers', async () => {
    const client = await connect(`${mcpBase}/mcp`, {
      'X-API-Key': ADMIN_KEY,
      'X-Plausible-Api-Key': PLAUSIBLE_KEY,
      'X-Plausible-Url': plausibleUrl,
      'X-Plausible-Sites': 'example.com',
    });
    assert.match(text(await client.callTool({ name: 'get_aggregate_stats', arguments: { compare: 'previous_period' } })), /\| visitors \| 100 \| 50 \| \+100% \|/);
    await client.close();
  });

  console.log('\nHTTP auth & safety');
  await check('invalid user key → 403', async () => {
    const { status, body } = await rawPost(`${mcpBase}/mcp/${KEYS.invalid}`);
    assert.equal(status, 403);
    assert.equal(body.error.data.reason, 'invalid_key');
  });
  await check('malformed user key → 403 without calling the key service', async () => {
    const before = keyServiceRequests.length;
    assert.equal((await rawPost(`${mcpBase}/mcp/usr_123`)).status, 403);
    assert.equal(keyServiceRequests.length, before);
  });
  await check('no credentials → 401; raw ?apiKey= → 401 with migration hint', async () => {
    assert.equal((await rawPost(`${mcpBase}/mcp`)).status, 401);
    const legacy = await rawPost(`${mcpBase}/mcp?apiKey=raw-key`);
    assert.equal(legacy.status, 401);
    assert.match(legacy.body.error.message, /no longer accepted/);
  });
  await check('wrong X-API-Key → 403', async () => {
    assert.equal((await rawPost(`${mcpBase}/mcp`, { 'X-API-Key': 'wrong', 'X-Plausible-Api-Key': 'k' })).status, 403);
  });
  await check('JSON-only clients get a JSON response, SSE clients get SSE', async () => {
    const call = accept => fetch(`${mcpBase}/mcp/${KEYS.readOnly}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: accept },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const jsonOnly = await call('application/json');
    assert.match(jsonOnly.headers.get('content-type'), /application\/json/);
    assert.ok((await jsonOnly.json()).result.tools.length > 0);
    const sse = await call('application/json, text/event-stream');
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    await sse.text();
  });
  await check('unknown paths are bucketed in analytics', async () => {
    await fetch(`${mcpBase}/wp-admin/${Math.random()}`);
    const data = await (await fetch(`${mcpBase}/analytics`, { headers: { 'X-API-Key': ADMIN_KEY } })).json();
    assert.ok(!Object.keys(data.breakdown.byEndpoint).some(key => key.startsWith('/wp-admin')));
    assert.ok(data.breakdown.byEndpoint.other >= 1);
  });
  await check('GET on the stateless endpoint → 405', async () => {
    assert.equal((await rawPost(`${mcpBase}/mcp/${KEYS.readOnly}`, {}, 'GET')).status, 405);
  });
  await check('private instance URLs are rejected (SSRF guard)', async () => {
    const { status, body } = await rawPost(`${mcpBase}/mcp/${KEYS.privateUrl}`);
    assert.equal(status, 400);
    assert.match(body.error.message, /private or internal/);
  });
  await check('analytics require MCP_API_KEY and never record user keys', async () => {
    assert.equal((await fetch(`${mcpBase}/analytics`)).status, 401);
    const res = await fetch(`${mcpBase}/analytics`, { headers: { 'X-API-Key': ADMIN_KEY } });
    const data = await res.json();
    assert.ok(data.summary.totalToolCalls > 0);
    assert.ok(!JSON.stringify(data).includes('usr_'), 'analytics must not contain user keys');
  });
  await check('key service down → 503', async () => {
    keyService.close();
    keyService.closeAllConnections?.();
    const { status, body } = await rawPost(`${mcpBase}/mcp/${KEYS.uncached}`);
    assert.equal(status, 503);
    assert.equal(body.error.data.reason, 'service_unavailable');
  });

  console.log('\nCLI / stdio mode');
  await check('stdio server lists tools and answers queries', async () => {
    const client = new Client({ name: 'smoke-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist/cli.js')],
      env: { ...process.env, PLAUSIBLE_API_KEY: PLAUSIBLE_KEY, PLAUSIBLE_URL: plausibleUrl, PLAUSIBLE_SITES: 'example.com' },
      stderr: 'ignore',
    }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('get_site_overview') && !names.includes('send_event'));
    assert.match(text(await client.callTool({ name: 'hello', arguments: {} })), /"transport": "stdio"/);
    await client.close();
  });

  console.log(`\nAll ${passed} smoke checks passed.`);
  await shutdown(0);
} catch (error) {
  console.error('\nSmoke test failed:', error);
  console.error('\n--- server log ---\n' + serverLog);
  await shutdown(1);
}

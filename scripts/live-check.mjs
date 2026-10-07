#!/usr/bin/env node
/**
 * Read-only live check against a real Plausible instance.
 *
 * Reads PLAUSIBLE_API_KEY, PLAUSIBLE_URL, PLAUSIBLE_SITES and (optionally)
 * PLAUSIBLE_PLUGIN_TOKENS from .env, starts dist/cli.js over stdio with writes
 * forced OFF, and prints the output of each read tool.
 *
 *   npm run live-check
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.PLAUSIBLE_API_KEY) {
  console.error('Set PLAUSIBLE_API_KEY (and PLAUSIBLE_URL / PLAUSIBLE_SITES) in .env first — see .env.sample.');
  process.exit(1);
}

const client = new Client({ name: 'live-check', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist/cli.js')],
  env: { ...process.env, PLAUSIBLE_ALLOW_WRITES: 'no' },
  stderr: 'inherit',
}));

const tools = (await client.listTools()).tools.map(tool => tool.name);
console.log(`\n${tools.length} tools: ${tools.join(', ')}\n`);

const calls = [
  ['get_instance_info', {}],
  ['list_sites', {}],
  ['get_site_overview', { date_range: '30d' }],
  ['get_aggregate_stats', { date_range: 'month', compare: 'previous_period' }],
  ['get_timeseries', { date_range: '7d', interval: 'day' }],
  ['get_breakdown', { dimension: 'source', date_range: '30d' }],
  ['get_breakdown', { dimension: 'page', date_range: '30d', metrics: ['visitors', 'pageviews', 'time_on_page', 'scroll_depth'] }],
  ['compare_periods', { date_range: '30d', dimension: 'country' }],
  ['get_goal_conversions', { date_range: '30d' }],
  ['get_realtime_visitors', {}],
  ['query_stats', { metrics: ['visitors'], date_range: '7d', dimensions: ['device', 'browser'], pagination: { limit: 5 } }],
  ...(tools.includes('list_goals') ? [['list_goals', {}], ['get_tracker_config', {}]] : []),
];

let failures = 0;
for (const [name, args] of calls) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) failures++;
  console.log(`${'='.repeat(80)}\n${name} ${JSON.stringify(args)}${result.isError ? '  [ERROR]' : ''}\n${'-'.repeat(80)}`);
  console.log(result.content.map(item => item.text).join('\n'));
  console.log();
}

await client.close();
console.log(`${calls.length - failures}/${calls.length} calls succeeded.`);
process.exit(failures ? 1 : 0);

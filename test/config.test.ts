import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectionConfigError,
  DEFAULT_PLAUSIBLE_URL,
  assertPublicPlausibleHost,
  createGuardedLookup,
  isPrivateAddress,
  normalizeBaseUrl,
  normalizeConnection,
  parseBoolean,
  parsePluginTokens,
  parseSites,
} from '../src/config.js';

describe('normalizeBaseUrl', () => {
  it('defaults to Plausible Cloud', () => {
    assert.equal(normalizeBaseUrl(undefined), DEFAULT_PLAUSIBLE_URL);
    assert.equal(normalizeBaseUrl('   '), DEFAULT_PLAUSIBLE_URL);
  });

  it('adds https, strips trailing slashes and pasted API paths', () => {
    assert.equal(normalizeBaseUrl('plausible.example.com'), 'https://plausible.example.com');
    assert.equal(normalizeBaseUrl('https://plausible.example.com///'), 'https://plausible.example.com');
    assert.equal(normalizeBaseUrl('https://plausible.example.com/api/v2/query'), 'https://plausible.example.com');
    assert.equal(normalizeBaseUrl('https://example.com/analytics/'), 'https://example.com/analytics');
    assert.equal(normalizeBaseUrl('http://10.0.0.5:8000'), 'http://10.0.0.5:8000');
  });

  it('rejects unsupported URLs', () => {
    assert.throws(() => normalizeBaseUrl('ftp://example.com'), ConnectionConfigError);
    assert.throws(() => normalizeBaseUrl('https://user:pass@example.com'), ConnectionConfigError);
    assert.throws(() => normalizeBaseUrl('https://example.com/?x=1'), ConnectionConfigError);
  });
});

describe('parseSites / parseBoolean', () => {
  it('splits, normalises and de-duplicates site domains', () => {
    assert.deepEqual(parseSites('Example.com, https://blog.example.com/ ; example.com\nshop.example.com'), [
      'example.com',
      'blog.example.com',
      'shop.example.com',
    ]);
    assert.deepEqual(parseSites(''), []);
  });

  it('understands common truthy values', () => {
    for (const value of ['yes', 'YES', 'true', '1', 'on', ' enabled ']) assert.equal(parseBoolean(value), true);
    for (const value of ['no', '', 'false', '0', undefined, null]) assert.equal(parseBoolean(value), false);
    assert.equal(parseBoolean(true), true);
  });
});

describe('parsePluginTokens', () => {
  it('parses domain=token pairs and keeps "=" inside tokens', () => {
    const { tokens, warnings } = parsePluginTokens('example.com=abc, blog.example.com=de=f', undefined);
    assert.deepEqual(tokens, { 'example.com': 'abc', 'blog.example.com': 'de=f' });
    assert.deepEqual(warnings, []);
  });

  it('assigns a single bare token to the default site', () => {
    assert.deepEqual(parsePluginTokens('abc123', 'example.com').tokens, { 'example.com': 'abc123' });
  });

  it('warns about entries it cannot use', () => {
    const { tokens, warnings } = parsePluginTokens('abc123', undefined);
    assert.deepEqual(tokens, {});
    assert.equal(warnings.length, 1);
  });
});

describe('normalizeConnection', () => {
  it('builds a complete connection', () => {
    const connection = normalizeConnection({
      apiKey: '  key  ',
      url: 'https://plausible.example.com/',
      sites: 'example.com',
      pluginTokens: 'blog.example.com=tok',
      allowWrites: 'yes',
    });
    assert.equal(connection.apiKey, 'key');
    assert.equal(connection.baseUrl, 'https://plausible.example.com');
    assert.equal(connection.defaultSite, 'example.com');
    assert.deepEqual(connection.sites, ['example.com', 'blog.example.com']);
    assert.equal(connection.allowWrites, true);
    assert.equal(connection.isCloud, false);
  });

  it('treats an empty URL as Plausible Cloud and requires an API key', () => {
    assert.equal(normalizeConnection({ apiKey: 'k', url: '' }).isCloud, true);
    assert.throws(() => normalizeConnection({ apiKey: '' }), ConnectionConfigError);
  });
});

describe('SSRF guard', () => {
  it('classifies private and public addresses', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.17.0.2', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '::ffff:a00:1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['1.1.1.1', '138.199.46.65', '8.8.8.8', '::ffff:8.8.8.8', '2a01:4f8:c0c:d5f::1']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it('rejects private IP literals unless allow-listed', async () => {
    await assert.rejects(assertPublicPlausibleHost('http://10.1.2.3:8000'), ConnectionConfigError);
    await assert.rejects(assertPublicPlausibleHost('http://[::1]:8000'), ConnectionConfigError);
    await assertPublicPlausibleHost('http://10.1.2.3:8000', ['10.1.2.3']);
    await assertPublicPlausibleHost('https://1.1.1.1');
  });

  it('defers hostnames to the connect-time guard (no DNS failures at session level)', async () => {
    await assertPublicPlausibleHost('http://localhost:8090');
    await assertPublicPlausibleHost('https://does-not-exist.invalid');
  });

  it('refuses private addresses at connect time unless allow-listed', async () => {
    const lookup = (allowed: string[]) =>
      new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>(resolve =>
        createGuardedLookup(allowed)('localhost', {}, (error, address) => resolve({ error, address })),
      );

    const blocked = await lookup([]);
    assert.match(String(blocked.error?.message), /private or internal/);
    assert.equal(blocked.error?.code, 'EPRIVATEADDRESS');

    const allowed = await lookup(['localhost']);
    assert.equal(allowed.error, null);
    assert.equal(typeof allowed.address, 'string');
  });
});

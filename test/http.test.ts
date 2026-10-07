import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { PlausibleApiError, configurePrivateAddressGuard, extractErrorMessage, plausibleRequest } from '../src/plausible/http.js';

let server: http.Server;
let baseUrl: string;
let rateLimitHits = 0;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(301, { Location: 'https://elsewhere.example.com/' }).end();
    } else if (req.url === '/rate-limited') {
      rateLimitHits++;
      if (rateLimitHits === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' }).end('{"error":"Too many"}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      }
    } else if (req.url === '/bad') {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"#/metrics/0: Invalid metric \\"foo\\""}');
    } else if (req.url === '/html-404') {
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html><body>Not Found</body></html>');
    } else if (req.url === '/echo-auth') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ auth: req.headers.authorization ?? null }));
    } else {
      res.writeHead(202).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe('extractErrorMessage', () => {
  it('handles every Plausible error shape', () => {
    assert.equal(extractErrorMessage({ error: 'bad' }), 'bad');
    assert.equal(extractErrorMessage({ errors: [{ detail: 'a' }, { detail: 'b' }] }), 'a; b');
    assert.equal(extractErrorMessage({ errors: { name: ["can't be blank"] } }), "name: can't be blank");
    assert.equal(extractErrorMessage('text'), undefined);
  });
});

describe('plausibleRequest', () => {
  it('surfaces API error messages', async () => {
    await assert.rejects(
      plausibleRequest(baseUrl, '/bad', { auth: { type: 'none' } }),
      (error: unknown) => error instanceof PlausibleApiError && error.status === 400 && /Invalid metric/.test(error.message),
    );
  });

  it('does not leak HTML bodies into messages', async () => {
    await assert.rejects(
      plausibleRequest(baseUrl, '/html-404', { auth: { type: 'none' } }),
      (error: unknown) => error instanceof PlausibleApiError && error.status === 404 && !error.message.includes('<html'),
    );
  });

  it('refuses to follow redirects', async () => {
    await assert.rejects(
      plausibleRequest(baseUrl, '/redirect', { auth: { type: 'none' } }),
      (error: unknown) => error instanceof PlausibleApiError && error.status === 301 && /elsewhere\.example\.com/.test(error.message),
    );
  });

  it('retries once on 429', async () => {
    const { data } = await plausibleRequest<{ ok: boolean }>(baseUrl, '/rate-limited', { auth: { type: 'none' } });
    assert.deepEqual(data, { ok: true });
    assert.equal(rateLimitHits, 2);
  });

  it('sends bearer and basic auth', async () => {
    const bearer = await plausibleRequest<{ auth: string }>(baseUrl, '/echo-auth', { auth: { type: 'bearer', token: 't' } });
    assert.equal(bearer.data.auth, 'Bearer t');
    const basic = await plausibleRequest<{ auth: string }>(baseUrl, '/echo-auth', { auth: { type: 'basic', username: 'example.com', password: 'tok' } });
    assert.equal(basic.data.auth, `Basic ${Buffer.from('example.com:tok').toString('base64')}`);
  });

  it('returns empty bodies as null', async () => {
    const { status, data } = await plausibleRequest(baseUrl, '/event', { method: 'POST', body: {}, auth: { type: 'none' } });
    assert.equal(status, 202);
    assert.equal(data, null);
  });

  it('releases the connection on retried 429s and redirects', async () => {
    rateLimitHits = 0;
    await plausibleRequest(baseUrl, '/rate-limited', { auth: { type: 'none' } });
    await assert.rejects(plausibleRequest(baseUrl, '/redirect', { auth: { type: 'none' } }), PlausibleApiError);
  });

  it('blocks private addresses at connect time when the guard is enabled', async () => {
    const port = new URL(baseUrl).port;
    configurePrivateAddressGuard(true);
    try {
      await assert.rejects(
        plausibleRequest(`http://localhost:${port}`, '/echo-auth', { auth: { type: 'none' } }),
        (error: unknown) => error instanceof PlausibleApiError && error.status === 0 && /private or internal/.test(error.message),
      );
      configurePrivateAddressGuard(true, ['localhost']);
      const { data } = await plausibleRequest<{ auth: string | null }>(`http://localhost:${port}`, '/echo-auth', { auth: { type: 'none' } });
      assert.equal(data.auth, null);
    } finally {
      configurePrivateAddressGuard(false);
    }
  });

  it('reports network failures as status 0', async () => {
    await assert.rejects(
      plausibleRequest('http://127.0.0.1:1', '/x', { auth: { type: 'none' }, timeoutMs: 2000 }),
      (error: unknown) => error instanceof PlausibleApiError && error.status === 0,
    );
  });
});

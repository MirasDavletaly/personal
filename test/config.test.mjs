// Configuration rules that protect a production installation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../dist/server/config.js';

const prod = (extra) => loadConfig({ NODE_ENV: 'production', DATA_DIR: '/data', ...extra });

test('production needs an https APP_BASE_URL', () => {
  assert.throws(() => prod({}), /APP_BASE_URL is required/);
  assert.throws(() => prod({ APP_BASE_URL: 'http://team.example.ts.net' }), /must use https/);
  assert.throws(() => prod({ APP_BASE_URL: 'https://team.example.ts.net/path' }), /without a path/);
  const c = prod({ APP_BASE_URL: 'https://team.tail81e59e.ts.net' });
  assert.equal(c.cookieSecure, true, 'Secure cookies on https');
  assert.equal(c.origin, 'https://team.tail81e59e.ts.net');
  assert.ok(c.allowedHosts.has('team.tail81e59e.ts.net'));
  assert.ok(!c.allowedHosts.has('127.0.0.1:8080'), 'no loopback host without a loopback proxy');
});

test('forwarded headers are trusted only from listed proxies', () => {
  const base = { APP_BASE_URL: 'https://team.tail81e59e.ts.net' };
  assert.equal(prod(base).trustProxy, false, 'default: trust nobody');
  for (const v of ['true', '*', '0.0.0.0/0']) assert.throws(() => prod({ ...base, TRUST_PROXY: v }), /specific proxy/);
  assert.throws(() => prod({ ...base, TRUST_PROXY: 'evil host' }), /bad address/);
  const lo = prod({ ...base, TRUST_PROXY: 'loopback' });
  assert.deepEqual(lo.trustProxy, ['127.0.0.1', '::1']);
  assert.ok(lo.allowedHosts.has('127.0.0.1:8080'), 'Tailscale Serve may connect as 127.0.0.1:8080');
  assert.deepEqual(prod({ ...base, TRUST_PROXY: '172.17.0.1' }).trustProxy, ['172.17.0.1']);
});

test('insecure cookies only together with the explicit test switch', () => {
  assert.throws(() => prod({ APP_BASE_URL: 'https://team.tail81e59e.ts.net', COOKIE_SECURE: 'false' }), /ALLOW_INSECURE_HTTP/);
  const c = prod({ APP_BASE_URL: 'http://127.0.0.1:8080', ALLOW_INSECURE_HTTP: 'true' });
  assert.equal(c.cookieSecure, false);
});

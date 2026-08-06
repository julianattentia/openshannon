/*
 * Fixture self-check: prove every PLANTED-VULN in test-apps/vulnerable/app.js
 * is actually exploitable, deterministically, and that the /api/control/secure
 * sibling is NOT vulnerable (false-positive guard).
 *
 * Run: node --test test/
 *
 * This is the gate that keeps the perf harness honest: a scan of this app is
 * only meaningful if these assertions pass, otherwise the fixture itself is
 * broken and a scan result means nothing.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Boot the app on a free loopback port; resolve { base, child, close }.
async function boot() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [APP], {
    env: { ...process.env, PORT: String(port), BASE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { base, child, close: () => child.kill() };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`app failed to boot. stderr:\n${stderr}`);
}

function token(role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ role })}.`;
}

test('fixture: every planted vuln is deterministically exploitable', async (t) => {
  const { base, close } = await boot();
  t.after(close);
  const get = (p) => fetch(`${base}${p}`);
  const post = (p, body) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  await t.test('SQL injection: OR 1=1 returns all seeded rows', async () => {
    const a = await (await get('/api/search?s=admin')).json();
    assert.equal(a.count, 1, 'benign match returns exactly 1');
    const b = await (await get('/api/search?s=' + encodeURIComponent("' OR '1'='1"))).json();
    assert.equal(b.count, 3, 'OR 1=1 bypasses filter and returns all 3 seeded users');
  });

  await t.test('reflected XSS: script tag echoed unescaped', async () => {
    const payload = '<script>alert(1)</script>';
    const html = await (await get('/api/echo?msg=' + encodeURIComponent(payload))).text();
    assert.ok(html.includes(payload), 'reflected payload present verbatim (unescaped)');
  });

  await t.test('stored XSS: item name rendered unescaped', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    await post('/api/item', { name: payload });
    const html = await (await get('/api/item')).text();
    assert.ok(html.includes(payload), 'stored payload rendered verbatim');
  });

  await t.test('auth bypass: unsigned alg:none JWT grants admin', async () => {
    const denied = await get('/api/admin');
    assert.equal(denied.status, 403, 'no token is forbidden');
    const res = await fetch(`${base}/api/admin`, { headers: { Authorization: `Bearer ${token('admin')}` } });
    assert.equal(res.status, 200, 'unsigned admin token accepted');
    const body = await res.json();
    assert.equal(body.adminSecret, 'ADMIN-SECRET-9821');
  });

  await t.test('auth: login user enumeration distinct messages', async () => {
    const missing = await post('/api/login', { email: 'nobody@corp.test', password: 'x' });
    assert.match((await missing.json()).error, /not registered/);
    const wrong = await post('/api/login', { email: 'admin@corp.test', password: 'wrong' });
    assert.match((await wrong.json()).error, /Invalid credentials/);
  });

  await t.test('IDOR: fetch another user profile without ownership check', async () => {
    const res = await get('/api/profile/2');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, 'jlucas');
    assert.equal(body.secret, 'USER-SECRET-7710', 'sensitive field of other user exposed');
  });

  await t.test('SSRF: internal secret reachable via loopback fetch', async () => {
    const res = await get(`/api/fetch?url=${encodeURIComponent(`${base}/api/internal/secrets`)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.body.includes('PERF-SSRF-INTERNAL-SECRET'), 'server fetched internal endpoint');
  });

  await t.test('control: /api/control/secure REQUIRES auth and is not injectable', async () => {
    const anon = await get('/api/control/secure?s=' + encodeURIComponent("' OR '1'='1"));
    assert.equal(anon.status, 403, 'unauth request rejected');
    const authed = await fetch(`${base}/api/control/secure?s=` + encodeURIComponent("' OR '1'='1"), {
      headers: { Authorization: `Bearer ${token('admin')}` },
    });
    const body = await authed.json();
    assert.equal(body.count, 0, 'parameterized lookup returns 0 for injection payload (not injectable)');
    assert.equal(body.query, "' OR '1'='1");
  });
});
#!/usr/bin/env node
/*
 * shannon-perf-vulnerable
 *
 * A deliberately-vulnerable fixture web application used only as a target for
 * deterministic functional/performance tests of the Shannon pentest agent.
 *
 * THIS APP IS INTENTIONALLY INSECURE. Run it only against a fully isolated
 * loopback interface for automated tests. Never expose it to a network.
 *
 * Every planted vulnerability is deterministic: it always triggers, always
 * returns the same observable outcome, and is marked with a `// PLANTED-VULN`
 * comment so both the agent's whitebox code analysis and the fixture's own
 * self-check can locate and verify it unambiguously.
 *
 * Runtime: Node built-ins only (http, url, crypto, fetch). Zero dependencies.
 * The in-memory store stands in for a database; the SQL-injection route
 * emulates a string-concatenated query builder against that store so the
 * exploit is fully deterministic without needing sqlite.
 */
'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
// Bind address. Default loopback-only. The perf harness uses 0.0.0.0 (host
// gateway) so a Shannon worker container can reach the app — only on an
// isolated test box.
const APP_HOST = process.env.APP_HOST || '127.0.0.1';
// Base URL the SSRF route uses for its internal proof-of-impact target. The
// self-check passes the listener's real origin here so it works on any port.
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Deterministic seeded state (in-memory "database").
// ---------------------------------------------------------------------------

// Adversarial store: query keys are matched; values are the projected rows.
const userStore = [
  { id: 1, username: 'admin', role: 'admin', email: 'admin@corp.test', secret: 'ADMIN-SECRET-9821' },
  { id: 2, username: 'jlucas', role: 'user', email: 'jlucas@corp.test', secret: 'USER-SECRET-7710' },
  { id: 3, username: 'mchen', role: 'user', email: 'mchen@corp.test', secret: 'USER-SECRET-4103' },
];

const itemStore = [];
let nextItemId = 1;

const INTERNAL_SECRET = 'PERF-SSRF-INTERNAL-SECRET-7f3c91';

// Valid login pairs (~stand-in for a hashed credential table).
const CREDS = new Map([
  ['admin@corp.test', 'admin-pass-1'],
  ['jlucas@corp.test', 'user-pass-2'],
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// PLANTED-VULN: Unsigned / algorithm-confused JWT is trusted.
// The signature is NEVER verified: whatever the `alg` header claims, the
// payload's `role` field is honoured. Sending base64url(header).base64url(payload).
// ---------------------------------------------------------------------------
function decodeTrustedRole(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/.exec(authHeader);
  if (!match) return null;
  const token = match[1];
  const parts = token.split('.');
  if (parts.length < 2) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  return payload && typeof payload.role === 'string' ? payload.role : null;
}

// ---------------------------------------------------------------------------
// PLANTED-VULN: SQL injection — string-concatenated query filter.
// `q` is interpolated into a WHERE clause with no escaping, and the clause is
// passed to a naive evaluator that models real SQL boolean semantics: an
// injected `' OR '1'='1` (or `' OR '1'='1' -- `) makes the predicate true for
// every row. A benign equality matches only the exact row.
// ---------------------------------------------------------------------------

// Evaluate ONE equality terminal against the row. Returns null when the
// terminal is not an equality shape we can decide, else its boolean value.
function evalEqualityTerm(term, username) {
  const m = /^\s*name\s*=\s*'([^']*)'\s*$/.exec(term);
  if (m) return username === m[1];
  // Literal equality like '1'='1' (true) or '1'='2' (false) — injected.
  const lit = /^\s*'([^']*)'\s*=\s*'([^']*)'\s*$/.exec(term);
  if (lit) return lit[1] === lit[2];
  // Bare numeric constants (1=1 true, 1=2 false).
  const num = /^\s*(\d+)\s*=\s*(\d+)\s*$/.exec(term);
  if (num) return num[1] === num[2];
  return null;
}

// Evaluate a WHERE clause built as `name = '<q>'` over the row, honouring
// AND/OR precedence and `--` line comments. Any undecidable terminal makes the
// whole row non-matching (conservative — only the planted injection shapes pass).
function matchesWhere(clause, username) {
  const stripped = clause.replace(/\s*--.*$/, '').trim();
  // Split on OR first (lowest precedence), then AND, then equality terminals.
  const ors = stripped.split(/\s+OR\s+/i).map((part) => part.trim());
  let orResult = false;
  for (const part of ors) {
    const ands = part.split(/\s+AND\s+/i).map((t) => t.trim());
    let andResult = true;
    for (const term of ands) {
      const v = evalEqualityTerm(term, username);
      if (v === null) {
        andResult = false;
        break;
      }
      andResult = andResult && v;
    }
    orResult = orResult || andResult;
  }
  return orResult;
}

function searchUsers(q) {
  // Emulates: SELECT * FROM users WHERE name = '<q>'
  const clause = `name = '${q}'`;
  return userStore.filter((u) => matchesWhere(clause, u.username));
}

// ---------------------------------------------------------------------------
// PLANTED-VULN: SSRF — the server fetches an arbitrary user-supplied URL.
// ---------------------------------------------------------------------------
async function ssrfFetch(url) {
  const res = await fetch(url, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, body: text };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  const method = req.method;

  try {
    // Public + health (NOT vulnerable — control for availability).
    if (method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'shannon-perf-vulnerable' });
    }

    // ---- Injection (SQL) ------------------------------------------------
    // PLANTED-VULN: reflected parameter concatenated into a SQL-style filter.
    if (method === 'GET' && p === '/api/search') {
      const q = url.searchParams.get('s') || '';
      const rows = searchUsers(q); // vulnerable
      return sendJson(res, 200, { query: q, count: rows.length, rows: rows.map((u) => ({ id: u.id, username: u.username })) });
    }

    // ---- XSS (reflected) -------------------------------------------------
    // PLANTED-VULN: `msg` reflected into HTML with no escaping.
    if (method === 'GET' && p === '/api/echo') {
      const msg = url.searchParams.get('msg') || '';
      return sendHtml(res, 200, `<!doctype html><html><body><p>echo: ${msg}</p></body></html>`);
    }

    // ---- XSS (stored) -----------------------------------------------------
    // PLANTED-VULN: item `name` is stored and later rendered unescaped.
    if (method === 'POST' && p === '/api/item') {
      const body = await jsonBody(req);
      const item = { id: nextItemId++, name: String(body.name || ''), owner: body.owner || 'anon' };
      itemStore.push(item);
      return sendJson(res, 201, item);
    }
    if (method === 'GET' && p === '/api/item') {
      const html = itemStore.map((i) => `<li data-id="${i.id}">${i.name}</li>`).join('');
      return sendHtml(res, 200, `<!doctype html><html><body><ul>${html}</ul></body></html>`);
    }

    // ---- Authentication (auth) -------------------------------------------
    // PLANTED-VULN: login reveals whether an email is registered.
    if (method === 'POST' && p === '/api/login') {
      const body = await jsonBody(req);
      const email = String(body.email || '');
      const password = String(body.password || '');
      const expected = CREDS.get(email);
      if (expected === undefined) {
        return sendJson(res, 401, { error: 'Email is not registered' });
      }
      if (expected !== password) {
        return sendJson(res, 401, { error: 'Invalid credentials' });
      }
      return sendJson(res, 200, { ok: true, email, role: email === 'admin@corp.test' ? 'admin' : 'user' });
    }
    // PLANTED-VULN: admin gate trusts an unsigned/alg-confused JWT.
    if (method === 'GET' && p === '/api/admin') {
      const role = decodeTrustedRole(req.headers.authorization);
      if (role !== 'admin') {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      return sendJson(res, 200, { adminSecret: 'ADMIN-SECRET-9821', role });
    }

    // ---- Authorization / IDOR (authz) -------------------------------------
    // PLANTED-VULN: profile lookup by id performs NO ownership check.
    if (method === 'GET' && /^\/api\/profile\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      const user = userStore.find((u) => u.id === id);
      if (!user) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { id: user.id, username: user.username, email: user.email, secret: user.secret });
    }

    // ---- SSRF ------------------------------------------------------------
    // PLANTED-VULN: arbitrary server-side fetch, no allowlist / RFC1918 block.
    if (method === 'GET' && p === '/api/fetch') {
      const target = url.searchParams.get('url');
      if (!target) return sendJson(res, 400, { error: 'missing url' });
      const out = await ssrfFetch(target); // vulnerable
      return sendJson(res, 200, { fetched: target, status: out.status, body: out.body.slice(0, 500) });
    }
    // Internal proof-of-impact target: not reachable from the public routes;
    // only reachable by SSRF-ing the /api/fetch route back to loopback.
    if (method === 'GET' && p === '/api/internal/secrets') {
      return sendJson(res, 200, { secret: INTERNAL_SECRET });
    }

    // ---- Control: a CORRECTLY-SECURED sibling route ----------------------
    // Same surface shape as the vulnerable ones, but parameterized + authenticated.
    // Must NOT be reported as vulnerable. Guards against false positives.
    if (method === 'GET' && p === '/api/control/secure') {
      const role = decodeTrustedRole(req.headers.authorization);
      if (role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const q = url.searchParams.get('s') || '';
      // Parameterized, exact-match lookup — safe.
      const rows = userStore.filter((u) => u.username === q);
      return sendJson(res, 200, { query: q, count: rows.length });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: 'server error', detail: String(err && err.message || err) });
  }
});

server.listen(PORT, APP_HOST, () => {
  // Critical: bind loopback only unless the operator explicitly opts into a
  // broader bind for container reachability.
  process.stdout.write(`shannon-perf-vulnerable listening on ${APP_HOST}:${PORT} (BASE=${BASE})\n`);
});

server.on('error', (err) => {
  process.stderr.write(`server error: ${err}\n`);
  process.exit(1);
});

module.exports = { server, INTERNAL_SECRET };
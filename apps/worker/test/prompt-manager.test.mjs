// Regression tests for the prompt-manager substitution seam — the file that
// conflicts on every upstream merge. Guards the fork's `code_context` mechanism
// and its coexistence with upstream's `AUTH_STATE_FILE` / shared-session block.
//   build first, then: node --test apps/worker/test/prompt-manager.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPrompt } from '../dist/services/prompt-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = path.join(HERE, '..', 'prompts');
const noopLogger = new Proxy({}, { get: () => () => {} });
const VARS = { webUrl: 'https://target.example', repoPath: '/repos/app', AUTH_STATE_FILE: '/tmp/auth-state.json' };

// Prompts the fork rewrote to be Hermes-compatible + target-agnostic.
const EDITED = ['vuln-auth', 'vuln-authz', 'vuln-ssrf', 'vuln-injection', 'exploit-injection', 'exploit-authz', 'recon'];
// Of those, the ones carrying a <code_context> injection block.
const WITH_CODE_CONTEXT_BLOCK = ['vuln-auth', 'vuln-authz', 'vuln-ssrf', 'recon'];
// Identifiers that must never appear hard-coded in committed prompt sources.
const TARGET_SPECIFIC = /attentia|brevo|posthog|supabase|getCurrentProfile|case_assignment|createAdminSupabaseClient|clinician/i;

function distributed(overrides = {}) {
  return {
    avoid: [],
    focus: [],
    authentication: null,
    description: '',
    vuln_classes: ['injection', 'xss', 'auth', 'authz', 'ssrf'],
    exploit: true,
    report: {},
    rules_of_engagement: '',
    code_context: '',
    ...overrides,
  };
}

const AUTH = {
  login_type: 'form',
  login_url: 'https://target.example/login',
  credentials: { username: 'tester' },
  success_condition: { type: 'url_contains', value: '/home' },
};

test('code_context is injected when configured, leaving no placeholder', async () => {
  const cfg = distributed({ code_context: 'SENTINEL_STACK_NOTE: user-scoped vs admin client.' });
  const out = await loadPrompt('vuln-ssrf', VARS, cfg, false, noopLogger, PROMPTS);
  assert.match(out, /SENTINEL_STACK_NOTE/);
  assert.doesNotMatch(out, /\{\{CODE_CONTEXT\}\}/);
});

test('code_context block is stripped when not configured', async () => {
  const out = await loadPrompt('vuln-ssrf', VARS, null, false, noopLogger, PROMPTS);
  assert.doesNotMatch(out, /\{\{CODE_CONTEXT\}\}/);
  assert.doesNotMatch(out, /SENTINEL_STACK_NOTE/);
});

test('all edited prompts render with a null config (no leftover placeholders)', async () => {
  // loadPrompt throws if any {{PLACEHOLDER}} survives, so a clean render is the assertion.
  for (const name of EDITED) {
    await assert.doesNotReject(() => loadPrompt(name, VARS, null, false, noopLogger, PROMPTS), `${name} (null config)`);
  }
});

test('all edited prompts render with an authenticated config (AUTH_STATE_FILE seam)', async () => {
  const cfg = distributed({ authentication: AUTH, code_context: 'SENTINEL' });
  for (const name of EDITED) {
    const out = await loadPrompt(name, VARS, cfg, false, noopLogger, PROMPTS);
    assert.doesNotMatch(out, /\{\{AUTH_STATE_FILE\}\}/, `${name} left {{AUTH_STATE_FILE}}`);
    assert.doesNotMatch(out, /\{\{CODE_CONTEXT\}\}/, `${name} left {{CODE_CONTEXT}}`);
  }
});

test('code_context block prompts actually inject the configured value', async () => {
  const cfg = distributed({ code_context: 'SENTINEL_XYZ' });
  for (const name of WITH_CODE_CONTEXT_BLOCK) {
    const out = await loadPrompt(name, VARS, cfg, false, noopLogger, PROMPTS);
    assert.match(out, /SENTINEL_XYZ/, `${name} did not inject code_context`);
  }
});

test('committed prompt sources carry no target-specific identifiers', () => {
  for (const name of EDITED) {
    const src = readFileSync(path.join(PROMPTS, `${name}.txt`), 'utf8');
    const hit = src.match(TARGET_SPECIFIC);
    assert.equal(hit, null, `${name}.txt leaks target-specific identifier: ${hit?.[0]}`);
  }
});

// Regression tests for config parsing + the fork's `code_context` field.
// Runs against the built dist via node:test (no TS runner / extra deps).
//   build first, then: node --test apps/worker/test/config-parser.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { distributeConfig, parseConfigYAML } from '../dist/config-parser.js';

test('code_context flows through parse → distribute', () => {
  const cfg = parseConfigYAML('code_context: |\n  Stack: Next.js + Supabase. Client: createServerSupabaseClient.\n');
  const distributed = distributeConfig(cfg);
  assert.match(distributed.code_context, /createServerSupabaseClient/);
});

test('absent code_context distributes as empty string (not undefined)', () => {
  const cfg = parseConfigYAML('rules_of_engagement: Be careful.\n');
  const distributed = distributeConfig(cfg);
  assert.equal(distributed.code_context, '');
});

test('code_context with angle brackets is rejected (HTML/XML injection guard)', () => {
  // The exact bug class hit during development: `informant_token_<inviteId>`
  // tripped the [<>] dangerous-pattern. Validation must reject it.
  assert.throws(
    () => parseConfigYAML('code_context: |\n  Cookie: informant_token_<inviteId> per invite.\n'),
    /dangerous pattern|code_context/i,
  );
});

test('code_context with a path-traversal sequence is rejected', () => {
  assert.throws(() => parseConfigYAML('code_context: see ../../etc/passwd\n'), /dangerous pattern|code_context/i);
});

test('a minimal rules_of_engagement-only config is valid', () => {
  const cfg = parseConfigYAML('rules_of_engagement: Owned staging target, full authorization.\n');
  const distributed = distributeConfig(cfg);
  assert.equal(distributed.rules_of_engagement, 'Owned staging target, full authorization.');
});

test('distributeConfig(null) yields safe defaults', () => {
  const distributed = distributeConfig(null);
  assert.equal(distributed.code_context, '');
  assert.equal(distributed.rules_of_engagement, '');
  assert.ok(Array.isArray(distributed.vuln_classes) && distributed.vuln_classes.length > 0);
});

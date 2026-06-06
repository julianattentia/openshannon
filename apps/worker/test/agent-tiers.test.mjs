// Locks the per-agent model-tier taxonomy (Layer A). Tiers drive model choice
// on the Claude executor (resolveModel) and on any agent routed to Claude.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS } from '../dist/session-manager.js';

const EXPECTED_TIER = {
  'pre-recon': 'large',
  recon: 'large',
  'injection-vuln': 'medium',
  'xss-vuln': 'medium',
  'ssrf-vuln': 'medium',
  'auth-vuln': 'large',
  'authz-vuln': 'large',
  'injection-exploit': 'medium',
  'xss-exploit': 'medium',
  'ssrf-exploit': 'medium',
  'auth-exploit': 'medium',
  'authz-exploit': 'medium',
  report: 'large',
};

test('every agent declares the expected model tier', () => {
  for (const [name, tier] of Object.entries(EXPECTED_TIER)) {
    assert.equal(AGENTS[name]?.modelTier, tier, `${name} tier`);
  }
});

test('every agent in the registry has an explicit modelTier (no silent default)', () => {
  for (const [name, def] of Object.entries(AGENTS)) {
    assert.ok(def.modelTier, `${name} is missing modelTier`);
  }
});

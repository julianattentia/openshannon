// Guards the Hermes-integrity invariant introduced by the upstream merge:
// the MCP collectors are only populated via the Claude Agent SDK channel, so on
// the Hermes path they stay empty and the activity must KEEP the agent's
// save-deliverable output instead of overwriting it with an empty render.
// These tests assert the precondition the activity fallback keys on.
//   build first, then: node --test apps/worker/test/collector-fallback.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createExploitCollector } from '../dist/mcp-server/exploit-collector.js';
import { createPreReconCollectorServer } from '../dist/mcp-server/pre-recon-collector.js';
import { createReconCollectorServer } from '../dist/mcp-server/recon-collector.js';
import { createVulnCollector } from '../dist/mcp-server/vuln-collector.js';

// Mirror of activities.ts `anyCollectorToolCalled` — the branch condition.
const anyCalled = (callStatus) => Object.values(callStatus).some((s) => s === 'called');

test('fresh pre-recon collector reports every tool skipped (Hermes path)', () => {
  const c = createPreReconCollectorServer();
  const status = c.getCallStatus();
  assert.ok(Object.keys(status).length > 0, 'expected a non-empty call-status map');
  assert.equal(anyCalled(status), false, 'an unused collector must not look "called"');
});

test('fresh recon collector reports every tool skipped', () => {
  const c = createReconCollectorServer();
  assert.equal(anyCalled(c.getCallStatus()), false);
});

test('fresh vuln collector reports every tool skipped (all classes)', () => {
  for (const cls of ['injection', 'xss', 'auth', 'authz', 'ssrf']) {
    const c = createVulnCollector(cls);
    assert.equal(anyCalled(c.getCallStatus()), false, `${cls} collector should be empty`);
  }
});

test('fresh exploit collector yields no entries (length-gated fallback)', () => {
  const c = createExploitCollector({ vulnClass: 'injection', validIds: new Set(['INJ-001']) });
  assert.equal(c.getAll().length, 0, 'an unused exploit collector must be empty');
});

// usedExecutors() — which executors a run will actually use (Layer C preflight).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { usedExecutors } from '../dist/services/preflight.js';

test('all-default run uses only hermes', () => {
  const set = usedExecutors(null, {});
  assert.deepEqual([...set].sort(), ['hermes']);
});

test('a single claude-routed agent adds claude to the set', () => {
  const set = usedExecutors({ 'authz-vuln': 'claude' }, {});
  assert.equal(set.has('claude'), true);
  assert.equal(set.has('hermes'), true);
});

test('SHANNON_EXECUTOR=claude makes the whole run claude', () => {
  const set = usedExecutors(null, { SHANNON_EXECUTOR: 'claude' });
  assert.deepEqual([...set], ['claude']);
});

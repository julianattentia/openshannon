// resolveAgentExecutorId precedence (Layer C).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAgentExecutorId } from '../dist/ai/executor/select.js';

test('config map wins over everything', () => {
  const id = resolveAgentExecutorId({
    agentName: 'authz-vuln',
    agentExecutors: { 'authz-vuln': 'claude' },
    agentDefault: 'hermes',
    env: { SHANNON_EXECUTOR: 'hermes' },
  });
  assert.equal(id, 'claude');
});

test('agent built-in default wins over env when config is silent', () => {
  const id = resolveAgentExecutorId({
    agentName: 'report',
    agentExecutors: {},
    agentDefault: 'claude',
    env: { SHANNON_EXECUTOR: 'hermes' },
  });
  assert.equal(id, 'claude');
});

test('falls through to env when config + agent default are silent', () => {
  const id = resolveAgentExecutorId({ agentName: 'recon', env: { SHANNON_EXECUTOR: 'claude' } });
  assert.equal(id, 'claude');
});

test('falls through to global default (hermes) when nothing is set', () => {
  const id = resolveAgentExecutorId({ agentName: 'recon', env: {} });
  assert.equal(id, 'hermes');
});

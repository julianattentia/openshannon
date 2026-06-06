// End-to-end routing test: a real config FILE flows through the actual parse →
// schema-validate → distribute → per-agent resolve → executor-instantiation
// chain (the same calls agent-execution.ts makes), and a routed Hermes agent is
// actually executed via the wrapper's mock mode. No GPU/Docker/Temporal.
//   build first, then: node --test apps/worker/test/routing-e2e.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { distributeConfig, parseConfig } from '../dist/config-parser.js';
import { resolveAgentExecutorId, selectAgentExecutor } from '../dist/ai/executor/select.js';
import { HermesAgentExecutor } from '../dist/ai/executor/hermes/executor.js';
import { AGENTS } from '../dist/session-manager.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const noopLogger = new Proxy({}, { get: () => () => {} });

// Mirror of agent-execution.ts's resolution: config map → agent default → global.
function resolveLikeAgentExecution(distributed, agentName) {
  return resolveAgentExecutorId({
    agentName,
    agentExecutors: distributed.agent_executors,
    agentDefault: AGENTS[agentName].executor,
    env: {}, // deterministic: no SHANNON_EXECUTOR → global default (hermes)
  });
}

function writeConfig(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shannon-routing-cfg-'));
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, body, 'utf8');
  return file;
}

test('a real mixed-routing config file resolves each agent to the right executor instance', async () => {
  const cfgPath = writeConfig(['agent_executors:', '  authz-vuln: claude', '  auth-vuln: claude', '  injection-vuln: hermes', ''].join('\n'));

  // Full real path: file → schema validation → parse → distribute.
  const distributed = distributeConfig(await parseConfig(cfgPath));

  const cases = [
    { agent: 'authz-vuln', expected: 'claude' },
    { agent: 'auth-vuln', expected: 'claude' },
    { agent: 'injection-vuln', expected: 'hermes' },
    { agent: 'recon', expected: 'hermes' }, // unrouted → global default
    { agent: 'report', expected: 'hermes' }, // unrouted → global default
  ];

  for (const { agent, expected } of cases) {
    const id = resolveLikeAgentExecution(distributed, agent);
    assert.equal(id, expected, `${agent} should resolve to ${expected}`);
    // Instantiate the actual executor object the pipeline would use.
    const executor = selectAgentExecutor({ executorId: id, logger: noopLogger, env: {} });
    assert.equal(executor.id, expected, `${agent} executor instance .id`);
  }
});

test('an all-default config routes every agent to hermes', async () => {
  const cfgPath = writeConfig('rules_of_engagement: owned target\n');
  const distributed = distributeConfig(await parseConfig(cfgPath));
  for (const agent of Object.keys(AGENTS)) {
    assert.equal(resolveLikeAgentExecution(distributed, agent), 'hermes', `${agent} default`);
  }
});

test('a Hermes-routed agent, once selected, actually executes (mock wrapper)', { skip: !hasPython }, async () => {
  const cfgPath = writeConfig('agent_executors:\n  injection-vuln: hermes\n');
  const distributed = distributeConfig(await parseConfig(cfgPath));
  const id = resolveLikeAgentExecution(distributed, 'injection-vuln');
  assert.equal(id, 'hermes');

  // Select the same executor id the pipeline resolved, then run it for real
  // (mock-result mode → python wrapper, no GPU).
  const executor = selectAgentExecutor({
    executorId: id,
    logger: noopLogger,
    env: {},
    hermes: { mockResult: '{"vulnerabilities": []}' },
  });
  assert.ok(executor instanceof HermesAgentExecutor);

  const sourceDir = mkdtempSync(path.join(tmpdir(), 'shannon-routing-src-'));
  process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), 'shannon-routing-home-'));
  const result = await executor.run({
    prompt: 'noop',
    sourceDir,
    context: '',
    description: 'routing-e2e',
    agentName: 'injection-vuln',
    auditSession: null,
    logger: noopLogger,
  });
  assert.equal(result.success, true, `routed hermes agent failed: ${result.error ?? 'unknown'}`);
  assert.match(result.result ?? '', /vulnerabilities/);
});

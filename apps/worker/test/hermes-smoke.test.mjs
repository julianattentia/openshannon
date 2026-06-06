// #4 — Hermes-path smoke test. Exercises the real Hermes execution plumbing
// (TS executor → python wrapper → result envelope → shapeResult) via the
// wrapper's `--mock-result` mode, which needs only python3 (no GPU, no Hermes
// lib, no Docker/Temporal). Also covers executor selection and the
// structured-output extraction the queue-writing path depends on.
//   build first, then: node --test apps/worker/test/hermes-smoke.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { HermesAgentExecutor } from '../dist/ai/executor/hermes/executor.js';
import { extractStructuredOutput } from '../dist/ai/executor/structured-output.js';
import { DEFAULT_EXECUTOR, resolveExecutorId } from '../dist/ai/executor/select.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const noopLogger = new Proxy({}, { get: () => () => {} });

test('default executor is Hermes (fork default)', () => {
  assert.equal(DEFAULT_EXECUTOR, 'hermes');
  assert.equal(resolveExecutorId({ env: {} }), 'hermes');
});

test('executor selection honors explicit arg and SHANNON_EXECUTOR', () => {
  assert.equal(resolveExecutorId({ env: { SHANNON_EXECUTOR: 'claude' } }), 'claude');
  assert.equal(resolveExecutorId({ executorId: 'claude', env: {} }), 'claude');
});

test('structured-output extraction finds + validates the vuln queue JSON', () => {
  const schema = {
    type: 'object',
    properties: { vulnerabilities: { type: 'array' } },
    required: ['vulnerabilities'],
  };
  // Mirrors a Hermes final turn: prose/announcement, then the bare JSON.
  const text = 'AUTH ANALYSIS COMPLETE\n\n{"vulnerabilities": []}';
  const extracted = extractStructuredOutput(text, schema);
  assert.equal(extracted.ok, true, extracted.ok ? '' : extracted.message);
  assert.ok(Array.isArray(extracted.value.vulnerabilities));
});

test('Hermes executor runs end-to-end via the python wrapper (mock-result)', { skip: !hasPython }, async () => {
  const mockResult = '{"vulnerabilities": []}';
  const executor = new HermesAgentExecutor({ mockResult });
  const sourceDir = mkdtempSync(path.join(tmpdir(), 'shannon-smoke-src-'));
  process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), 'shannon-smoke-home-'));

  const result = await executor.run({
    prompt: 'noop smoke prompt',
    sourceDir,
    context: '',
    description: 'hermes smoke',
    agentName: 'injection-vuln',
    auditSession: null,
    logger: noopLogger,
  });

  assert.equal(result.success, true, `executor failed: ${result.error ?? 'unknown'}`);
  assert.match(result.result ?? '', /vulnerabilities/);
});

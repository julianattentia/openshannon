// resolveHermesTargetForAgent precedence (Layer B): config named targets →
// agent_models.default → single SHANNON_HERMES_* env.
//   build first, then: node --test apps/worker/test/hermes-model-target.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveHermesTargetForAgent } from '../dist/ai/executor/hermes/model-target.js';

const MODELS = {
  orchestrator: { provider: 'nous', model: 'stepfun/step-3.7-flash:free', base_url: 'https://inference-api.nousresearch.com/v1' },
  task: { provider: 'custom', model: 'Qwen3.6-27B', base_url: 'http://local:8000/v1' },
};
const SINGLE_ENV = {
  SHANNON_HERMES_PROVIDER: 'custom',
  SHANNON_HERMES_MODEL: 'Qwen-default',
  SHANNON_HERMES_BASE_URL: 'http://default:8000/v1',
};

test('agent_models[agent] selects its named target', () => {
  const t = resolveHermesTargetForAgent({
    agentName: 'recon',
    hermesModels: MODELS,
    agentModels: { recon: 'orchestrator', default: 'task' },
    env: SINGLE_ENV,
  });
  assert.deepEqual(t, { provider: 'nous', model: 'stepfun/step-3.7-flash:free', baseUrl: 'https://inference-api.nousresearch.com/v1' });
});

test('unlisted agent falls back to agent_models.default', () => {
  const t = resolveHermesTargetForAgent({
    agentName: 'injection-vuln',
    hermesModels: MODELS,
    agentModels: { recon: 'orchestrator', default: 'task' },
    env: SINGLE_ENV,
  });
  assert.deepEqual(t, { provider: 'custom', model: 'Qwen3.6-27B', baseUrl: 'http://local:8000/v1' });
});

test('no config → single SHANNON_HERMES_* env (regression: existing single-model runs unchanged)', () => {
  const t = resolveHermesTargetForAgent({
    agentName: 'recon',
    hermesModels: {},
    agentModels: {},
    env: SINGLE_ENV,
  });
  assert.deepEqual(t, { provider: 'custom', model: 'Qwen-default', baseUrl: 'http://default:8000/v1' });
});

test('partial named target inherits missing fields from single env', () => {
  const t = resolveHermesTargetForAgent({
    agentName: 'report',
    hermesModels: { big: { model: 'only-model' } },
    agentModels: { report: 'big' },
    env: SINGLE_ENV,
  });
  assert.deepEqual(t, { provider: 'custom', model: 'only-model', baseUrl: 'http://default:8000/v1' });
});

test('empty config + empty env → empty object', () => {
  const t = resolveHermesTargetForAgent({ agentName: 'recon', hermesModels: {}, agentModels: {}, env: {} });
  assert.deepEqual(t, {});
});

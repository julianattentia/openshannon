// hermes_models / agent_models config parsing + validation (Layer B).
//   build first, then: node --test apps/worker/test/config-models.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { distributeConfig, parseConfigYAML } from '../dist/config-parser.js';

const CFG = [
  'hermes_models:',
  '  orchestrator: { provider: nous, model: "stepfun/step-3.7-flash:free", base_url: "https://inference-api.nousresearch.com/v1" }',
  '  task: { provider: custom, model: "Qwen3.6-27B", base_url: "http://local:8000/v1" }',
  'agent_models:',
  '  recon: orchestrator',
  '  default: task',
  '',
].join('\n');

test('hermes_models + agent_models flow through parse → distribute', () => {
  const d = distributeConfig(parseConfigYAML(CFG));
  assert.equal(d.hermes_models.orchestrator.model, 'stepfun/step-3.7-flash:free');
  assert.equal(d.hermes_models.orchestrator.provider, 'nous');
  assert.equal(d.agent_models.recon, 'orchestrator');
  assert.equal(d.agent_models.default, 'task');
});

test('absent maps distribute as empty objects', () => {
  const d = distributeConfig(parseConfigYAML('rules_of_engagement: ok\n'));
  assert.deepEqual(d.hermes_models, {});
  assert.deepEqual(d.agent_models, {});
});

test('agent_models with an unknown agent name is rejected', () => {
  const bad = 'hermes_models:\n  task: { model: m }\nagent_models:\n  not-an-agent: task\n';
  assert.throws(() => parseConfigYAML(bad), /agent_models references unknown agent/i);
});

test('agent_models pointing at an undefined label is rejected', () => {
  const bad = 'hermes_models:\n  task: { model: m }\nagent_models:\n  recon: missing-label\n';
  assert.throws(() => parseConfigYAML(bad), /undefined model label/i);
});

test('"default" is an accepted agent_models key', () => {
  const ok = 'hermes_models:\n  task: { model: m }\nagent_models:\n  default: task\n';
  assert.doesNotThrow(() => parseConfigYAML(ok));
});

// agent_executors parsing/validation/distribution (Layer C).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { distributeConfig, parseConfigYAML } from '../dist/config-parser.js';

test('agent_executors flows through parse → distribute', () => {
  const cfg = parseConfigYAML('agent_executors:\n  authz-vuln: claude\n  injection-vuln: hermes\n');
  const d = distributeConfig(cfg);
  assert.equal(d.agent_executors['authz-vuln'], 'claude');
  assert.equal(d.agent_executors['injection-vuln'], 'hermes');
});

test('absent agent_executors distributes as empty object', () => {
  const d = distributeConfig(parseConfigYAML('rules_of_engagement: ok\n'));
  assert.deepEqual(d.agent_executors, {});
});

test('unknown agent name is rejected', () => {
  assert.throws(() => parseConfigYAML('agent_executors:\n  not-an-agent: claude\n'), /agent_executors|unknown agent/i);
});

test('unknown executor id is rejected', () => {
  assert.throws(() => parseConfigYAML('agent_executors:\n  authz-vuln: gpt4\n'), /enum|executor|claude|hermes/i);
});

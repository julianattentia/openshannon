import test from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_TARGETS, resolveTarget } from '../lib/target-policy.mjs';
import { summarizeReport } from '../lib/report-summary.mjs';

test('accepts only the two exact local fixture paths', () => {
  assert.equal(resolveTarget(ALLOWED_TARGETS.crapi).name, 'crapi');
  assert.equal(resolveTarget(ALLOWED_TARGETS.vulnerable).name, 'vulnerable');
});

test('rejects unset, remote, production-like, and non-allowlisted targets', () => {
  for (const hostile of [
    undefined,
    '',
    'https://staging.attentia.at',
    'https://crypto.attentia.at',
    '46.224.100.69',
    'file:///etc/passwd',
    'http://127.0.0.1:9999',
    '/tmp/other-target',
  ]) {
    assert.throws(() => resolveTarget(hostile), /REFUSING|REJECTED|DENIED/);
  }
});

test('summarizes severity headings without copying report content', () => {
  const result = summarizeReport([
    '# Comprehensive Security Assessment',
    '## Critical Findings',
    '## High Findings',
    '## High Findings',
    '## Medium Findings',
    '## Informational Findings',
    'raw payload must not be emitted',
  ].join('\n'));

  assert.deepEqual(result.counts, {
    critical: 1,
    high: 2,
    medium: 1,
    low: 0,
    informational: 1,
  });
  assert.equal(result.message.includes('raw payload'), false);
});

// Unit test for perf/lib/assert-findings.mjs — deterministic PASS/FAIL logic.
// Uses synthetic (hand-written) deliverables; no network, no Shannon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { assertFindings } from '../lib/assert-findings.mjs';
import vulnerable from '../targets/vulnerable.mjs';

// Source of truth = the vulnerable target's own expectations (no drift).
const EXPECTATIONS = vulnerable.expectations;

/** Realistic per-class deliverable that references the planted endpoint. */
const FOUND = {
  injection: '## Injection\nThe /api/search endpoint concatenates user input into a WHERE clause (SQL injection).',
  xss: '## XSS\nReflected script on /api/echo; stored on /api/item rendered unescaped.',
  auth: '## Authentication\nUnsigned JWT accepted on /api/admin; /api/login leaks user enumeration.',
  authz: '## Authorization\n/api/profile/:id returns any user record (IDOR).',
  ssrf: '## SSRF\n/api/fetch makes an arbitrary server-side request.',
};
const CONTROL = 'control endpoint /api/control/secure verified as safe.';

async function writeDeliverables(dir, contents) {
  await mkdir(dir, { recursive: true });
  for (const [className, text] of Object.entries(contents)) {
    const file = `${className}_analysis_deliverable.md`;
    await writeFile(path.join(dir, file), text);
  }
}

async function fixtures() {
  const dir = await mkdtemp(path.join(tmpdir(), 'shannon-perf-assert-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('all classes PASS when each deliverable references its planted indicator', async () => {
  const { dir, cleanup } = await fixtures();
  try {
    await writeDeliverables(dir, FOUND);
    const report = await assertFindings(dir, EXPECTATIONS);
    assert.equal(report.pass, true, 'all planted vulns found');
    for (const r of report.results) assert.equal(r.pass, true, `${r.className} should pass`);
  } finally {
    await cleanup();
  }
});

test('a class FAILs when its deliverable lacks any indicator', async () => {
  const { dir, cleanup } = await fixtures();
  try {
    // authz deliverable exists but does not reference the planted surface.
    const bad = { ...FOUND, authz: '## Authorization\nNo privilege issues found in the application.' };
    await writeDeliverables(dir, bad);
    const report = await assertFindings(dir, EXPECTATIONS);
    assert.equal(report.pass, false);
    const authz = report.results.find((r) => r.className === 'authz');
    assert.equal(authz.pass, false, 'authz must not pass without an indicator');
  } finally {
    await cleanup();
  }
});

test('a missing deliverable file yields FAIL (file absent)', async () => {
  const { dir, cleanup } = await fixtures();
  try {
    const missing = { ...FOUND };
    delete missing.ssrf;
    await writeDeliverables(dir, missing);
    const report = await assertFindings(dir, EXPECTATIONS);
    assert.equal(report.pass, false);
    const ssrf = report.results.find((r) => r.className === 'ssrf');
    assert.equal(ssrf.pass, false);
    assert.equal(ssrf.fileFound ?? ssrf.file ?? null, null, 'no file for ssrf');
  } finally {
    await cleanup();
  }
});

test('control-endpoint mention is surfaced, non-fatal', async () => {
  const { dir, cleanup } = await fixtures();
  try {
    await writeDeliverables(dir, { ...FOUND, ssrf: FOUND.ssrf + '\n' + CONTROL });
    const report = await assertFindings(dir, EXPECTATIONS);
    assert.equal(report.pass, true, 'control mention must not fail the run');
    const ssrf = report.results.find((r) => r.className === 'ssrf');
    assert.equal(ssrf.controlMentioned, true);
  } finally {
    await cleanup();
  }
});
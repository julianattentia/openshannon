/*
 * Deterministic assertion of Shannon perf/target deliverables.
 *
 * Purely functional: given a directory of Shannon's copied deliverables and a
 * per-class expectation set, decide whether each planted vulnerability was
 * found/reported. Returns a report object; never touches the network.
 *
 * Tolerant by design: the vulnerability agents' prose is LLM-written and not
 * stable word-for-word, so a class PASSes when its deliverable file is
 * present, non-empty and matches at least one of the class's indicators
 * (endpoint paths and/or keyword regexes). The most specific signal matched is
 * recorded. A control-endpoint mention in any class result is surfaced as an
 * informational false-positive smoke-out, never a hard failure.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// File names Shannon produces for each vuln class (see AGENTS registry).
const CLASS_FILES = {
  injection: ['injection_analysis_deliverable.md', 'injection_findings.md'],
  xss: ['xss_analysis_deliverable.md', 'xss_findings.md'],
  auth: ['auth_analysis_deliverable.md', 'auth_findings.md'],
  authz: ['authz_analysis_deliverable.md', 'authz_findings.md'],
  ssrf: ['ssrf_analysis_deliverable.md', 'ssrf_findings.md'],
};

function matchesAny(text, patterns) {
  for (const pattern of patterns) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(escapeRe(pattern), 'i');
    const m = re.exec(text);
    if (m) return { matched: true, signal: m[0] };
  }
  return { matched: false, signal: null };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Assert one class's deliverable against its mark.
 * @returns {{className, pass, file, bytes, matchedSignal, controlMentioned}}
 */
async function assertClass(outDir, className, mark) {
  const file = CLASS_FILES[className];
  let best = { matched: false, signal: null, fileFound: null, bytes: 0 };
  for (const name of file) {
    const p = path.join(outDir, name);
    let text;
    try {
      text = await fs.readFile(p, 'utf8');
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(text);
    const hit = matchesAny(text, mark.indicators);
    if (hit.matched) {
      return {
        className,
        pass: true,
        file: name,
        bytes,
        matchedSignal: hit.signal,
        controlMentioned: /api\/control\/secure/i.test(text),
      };
    }
    if (best.fileFound === null) {
      best = { ...best, fileFound: name, bytes };
    }
  }
  return {
    className,
    pass: false,
    file: best.fileFound,
    bytes: best.bytes,
    matchedSignal: null,
    controlMentioned: false,
  };
}

/**
 * Assert every expected class against the deliverables in `outDir`.
 * @param {string} outDir       Directory Shannon copied deliverables into (-o).
 * @param {Record<string, {indicators: Array<string|RegExp>}>} expectations
 * @returns {Promise<{results: Array<object>, pass: boolean}>}
 */
export async function assertFindings(outDir, expectations) {
  const results = [];
  for (const [className, mark] of Object.entries(expectations)) {
    results.push(await assertClass(outDir, className, mark));
  }
  const pass = results.every((r) => r.pass);
  return { results, pass };
}

export { CLASS_FILES, matchesAny };
export { __dirname as assertionsDir };
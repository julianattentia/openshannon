#!/usr/bin/env node
/*
 * perf/run.mjs — deterministic functional/performance harness for Shannon.
 *
 * Boots a target web app, runs Shannon against it in `--no-exploit` mode
 * (full vuln suite), then deterministically asserts whether each planted
 * vulnerability class was found in the deliverables.
 *
 * Usage:
 *   node perf/run.mjs --target vulnerable
 *   node perf/run.mjs --target vulnerable --only vuln:ssrf
 *   node perf/run.mjs --target vulnerable --dry-run   # boot + self-check, skip scan
 *
 * Targets are registered in perf/targets/. `vulnerable` is implemented;
 * `crapi` and `juice-shop` are declared but not wired yet.
 *
 * The live scan step requires Docker (Temporal infra) + LLM credentials, so it
 * is gated exactly like scripts/hermes-staging-preflight.sh: if the environment
 * can not run a real scan, this exits 0 (skipped) with a clear message.
 */
import { spawnSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { assertFindings } from './lib/assert-findings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHANNON = path.join(REPO_ROOT, 'shannon');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    target: 'vulnerable',
    out: null,
    workspace: null,
    only: null,
    dryRun: false,
    appUrl: null,
    keepApp: false,
    stage: true,
    provider: null,
    model: null,
    baseUrl: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--workspace' || a === '-w') args.workspace = argv[++i];
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--app-url') args.appUrl = argv[++i];
    else if (a === '--provider') args.provider = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-stage') args.stage = false;
    else if (a === '--keep-app') args.keepApp = true;
    else if (a === '--help' || a === '-h') {
      console.log(`perf/run.mjs — deterministic Shannon perf harness

  --target <name>   Target fixture (default: vulnerable; planned: crapi, juice-shop)
  --out <dir>       Deliverables output dir (default: <tmp>/shannon-perf-out)
  -w,--workspace    Shannon workspace name (default: shannon-perf-<ts>)
  --only <phase>    Narrow the scan to one phase (e.g. vuln:ssrf)
  --app-url <url>   Override the target URL passed to Shannon (default 127.0.0.1:<port>)
  --dry-run         Boot the app + run its self-check, skip the Shannon scan
  --no-stage        Use test-apps/<target> in place instead of a staged git copy
  --keep-app        Leave the app running after the run (debug)
`);
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Target loading
// ---------------------------------------------------------------------------

async function loadTarget(name) {
  const p = path.join(__dirname, 'targets', `${name}.mjs`);
  let mod;
  try {
    mod = await import(p);
  } catch (err) {
    throw new Error(`Unknown perf target "${name}" (expected ${p}).\n${err.message}`);
  }
  const target = mod.default;
  if (!target.expectations) {
    throw new Error(
      `Perf target "${name}" is declared but not implemented yet (no expectations). ` +
        `Planned targets: crapi, juice-shop. Only "vulnerable" is wired.`,
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(probe, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      if ((await probe()) === true) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last}` : ''}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed (exit ${res.status}):\n${res.stderr || res.stdout}`);
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ---------------------------------------------------------------------------
// Target lifecycle
// ---------------------------------------------------------------------------

async function stageGitRepo(src, targetDir) {
  // Copy the fixture source and make it a git checkout so missing-deliverable
  // resume / git-manager bookkeeping works and the whitebox analysis reads real
  // committed code.
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(src, targetDir, { recursive: true, filter: (p) => !p.includes('node_modules') && !p.includes('.git') });
  run('git', ['init', '-q'], { cwd: targetDir });
  run('git', ['config', 'user.email', 'perf@test'], { cwd: targetDir });
  run('git', ['config', 'user.name', 'shannon-perf'], { cwd: targetDir });
  run('git', ['add', '-A'], { cwd: targetDir });
  run('git', ['commit', '-qm', 'fixture seed'], { cwd: targetDir });
}

// Boot the app as an async child (non-blocking).
function spawnApp(target, port, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(target.appSrc, target.entry)], {
    env: { ...process.env, PORT: String(port), APP_HOST: host, BASE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, base };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function shannonReachable() {
  try {
    return spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = await loadTarget(args.target);
  const started = Date.now();

  console.log(`\n=== Shannon perf harness ===`);
  console.log(`target: ${target.name}  (${target.description})`);
  console.log(`dry-run: ${args.dryRun ? 'yes (boot + self-check only)' : 'no'}`);

  const ws = args.workspace || `shannon-perf-${Math.floor(Date.now() / 1000)}`;
  const outDir = args.out || path.join(tmpdir(), 'shannon-perf-out');
  await fs.mkdir(outDir, { recursive: true });

  const port = await freePort();
  // Container mode (a real scan): the Shannon worker runs in Docker, so it must
  // reach both the LLM and the target via host-gateway → 0.0.0.0 bind + a
  // host.docker.internal URL. Dry-run stays loopback-only.
  const containerMode = !args.dryRun;
  const appHost = containerMode ? '0.0.0.0' : '127.0.0.1';
  const appBase =
    args.appUrl || (containerMode ? `http://host.docker.internal:${port}` : `http://127.0.0.1:${port}`);

  // ---- Stage + boot ------------------------------------------------------
  const stagedDir = args.stage ? path.join(tmpdir(), `shannon-perf-repo-${ws}`) : target.appSrc;
  if (args.stage) {
    console.log(`\n[1/4] staging git checkout of ${target.appSrc} -> ${stagedDir}`);
    await stageGitRepo(target.appSrc, stagedDir);
  }
  console.log(`\n[2/4] booting ${target.name} app on ${appHost}:${port} (container-mode: ${containerMode})`);
  const { child, base } = spawnApp(target, port, { host: appHost });
  try {
    await waitFor(async () => (await fetch(`${base}${target.healthPath}`)).ok, 10_000, 'app health');

    if (args.dryRun) {
      console.log('dry-run: running fixture self-check...');
      const sc = run('node', ['--test'], { cwd: target.appSrc, allowFailure: true });
      const allPass = sc.stdout.includes('# fail 0');
      console.log(sc.stdout.split('\n').filter((l) => /(^#|ok |not ok)/.test(l)).join('\n'));
      console.log(allPass ? '\nFIXTURE SELF-CHECK: PASS' : `\nFIXTURE SELF-CHECK: FAIL (exit ${sc.status})`);
      process.exit(allPass ? 0 : 1);
    }

    // ---- Scan ------------------------------------------------------------
    console.log(`\n[3/4] running Shannon scan of ${appBase} (repo ${stagedDir})...`);
    if (!shannonReachable()) {
      console.log(
        '\nSKIP: no reachable Docker daemon in this environment, so a live scan cannot run here.\n' +
          'To run the real scan on a machine with Docker + provider credentials:\n\n' +
          `  ${SHANNON} start -u ${appBase} -r ${stagedDir} --no-exploit --pipeline-testing -w ${ws} -o ${outDir}` +
          (args.only ? ` --only ${args.only}` : '') +
          '\n\nThen re-run this harness there; it will assert the deliverables automatically.',
      );
      return 0;
    }
    const scanArgs = [
      'start', '-u', appBase, '-r', stagedDir,
      '--no-exploit', '--pipeline-testing', '-w', ws, '-o', outDir,
    ];
    if (args.only) scanArgs.push('--only', args.only);
    // Thread the resolved Hermes model target into the scan environment so the
    // worker's synthesized config uses the local Qwen server.
    const scanEnv = {
      ...process.env,
      ...(args.provider && { SHANNON_HERMES_PROVIDER: args.provider }),
      ...(args.model && { SHANNON_HERMES_MODEL: args.model }),
      ...(args.baseUrl && { SHANNON_HERMES_BASE_URL: args.baseUrl }),
    };
    const before = Date.now();
    const scan = spawnSync(SHANNON, scanArgs, { encoding: 'utf8', stdio: 'inherit', env: scanEnv });
    const scanMs = Date.now() - before;
    if (scan.status !== 0) {
      console.error(`\nShannon scan failed (exit ${scan.status}). Check workspace ${ws}.`);
      process.exit(scan.status ?? 1);
    }

    // ---- Assert ----------------------------------------------------------
    console.log(`\n[4/4] asserting deliverables in ${outDir} (scan took ${Math.round(scanMs / 1000)}s)`);
    const report = await assertFindings(outDir, target.expectations);
    let failed = 0;
    for (const r of report.results) {
      const verdict = r.pass ? 'PASS' : 'FAIL';
      if (!r.pass) failed += 1;
      const file = r.fileFound ?? r.file ?? '<absent>';
      console.log(
        `  [${verdict}] ${r.className.padEnd(10)} planted: ${target.expectations[r.className].planted}`,
      );
      console.log(`      ${r.pass ? `matched "${r.matchedSignal}"` : 'no indicator matched'} in ${file} (${r.bytes}b)`);
      if (r.controlMentioned) console.log(`      INFO: control endpoint /api/control/secure mentioned (false-positive smoke-out)`);
    }
    console.log(`\nVerdict: ${report.pass ? 'ALL PLANTED VULNS FOUND' : `${failed} CLASS(ES) NOT FOUND`}`);
    console.log(`Total: ${Math.round((Date.now() - started) / 1000)}s`);
    if (!args.keepApp) child.kill();
    process.exit(report.pass ? 0 : 1);
  } finally {
    if (!args.keepApp) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

main().catch((err) => {
  console.error(`\nperf harness error: ${err.message}`);
  process.exit(1);
});
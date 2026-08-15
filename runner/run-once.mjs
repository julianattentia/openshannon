#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveTarget } from './lib/target-policy.mjs';
import { summarizeReport } from './lib/report-summary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const WORKSPACES_DIR = path.join(ROOT, 'workspaces');
const LEDGER_PATH = path.join(REPORTS_DIR, 'run-ledger.jsonl');
const MODEL_URL = 'http://127.0.0.1:8000/v1/models';
// The queue proxy listens on host loopback. The worker is a container, so
// host.docker.internal reaches that same queue port without using :8001.
const WORKER_QUEUE_URL = 'http://host.docker.internal:8000/v1';
const MODEL_ID = '/models/Qwen3.8-27B-Q4_K_M.gguf';
const MAX_WALL_SECONDS = 1800;
const PHASES = new Set(['pre-recon', 'recon', 'vuln:auth']);

function usage(message) {
  if (message) console.error(`ERROR: ${message}`);
  console.error('Usage: runner/run-once.mjs --target <exact-local-fixture> [--phase pre-recon|recon|vuln:auth] [--profile scheduled] [--workspace <name>] [--timeout-seconds <60..1800>] [--dry-run]');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const args = { target: undefined, phase: 'pre-recon', profile: undefined, workspace: undefined, timeoutSeconds: 900, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--target') args.target = argv[++index];
    else if (arg === '--phase') args.phase = argv[++index];
    else if (arg === '--profile') args.profile = argv[++index];
    else if (arg === '--workspace') args.workspace = argv[++index];
    else if (arg === '--timeout-seconds') args.timeoutSeconds = Number(argv[++index]);
    else if (arg === '--help') return usage();
    else return usage(`unknown option '${arg}'`);
  }
  if (args.profile && args.profile !== 'scheduled') return usage(`unsupported profile '${args.profile}'`);
  if (args.profile === 'scheduled' && args.phase !== 'pre-recon') return usage('--profile scheduled cannot be combined with --phase');
  if (!args.profile && !PHASES.has(args.phase)) return usage(`unsupported phase '${args.phase}'`);
  if (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 60 || args.timeoutSeconds > MAX_WALL_SECONDS) {
    return usage(`--timeout-seconds must be an integer from 60 to ${MAX_WALL_SECONDS}`);
  }
  if (args.workspace && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.workspace)) {
    return usage('--workspace must be a short alphanumeric name');
  }
  return args;
}

function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    timeout: options.timeout,
  });
}

async function checkModel() {
  const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`local model queue returned HTTP ${response.status}`);
  const body = await response.json();
  const id = body?.data?.[0]?.id;
  if (id !== MODEL_ID) throw new Error(`local model id '${id ?? '<missing>'}' is not the required '${MODEL_ID}'`);
  console.log(`model=${id}`);
}

function checkTemporal() {
  const listed = runSync('docker', ['ps', '--filter', 'name=^shannon-temporal$', '--format', '{{.Names}}']);
  if (listed.status !== 0 || listed.stdout.trim() !== 'shannon-temporal') {
    throw new Error('Temporal container shannon-temporal is not running; shared infrastructure was not recreated.');
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 7233 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Temporal port 127.0.0.1:7233 was not reachable.'));
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      console.log('temporal=shannon-temporal reachable=127.0.0.1:7233');
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Temporal port check failed: ${error.message}`));
    });
  });
}

async function waitForHttp(url, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.status >= 100 && response.status < 600) {
        console.log(`target=${url} responded_http=${response.status}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`target '${url}' did not answer within ${timeoutSeconds}s (${lastError})`);
}

function startTarget(target) {
  if (target.name === 'crapi') {
    const composeFile = path.join(target.path, target.composeFile);
    if (!fs.existsSync(composeFile)) throw new Error(`crAPI compose file missing at '${composeFile}'`);
    console.log(`starting_target=crapi compose=${composeFile}`);
    const result = runSync('docker', ['compose', '-f', composeFile, '--compatibility', 'up', '-d'], {
      cwd: target.path,
      env: { ...process.env, LISTEN_IP: '0.0.0.0' },
      stdio: 'inherit',
      timeout: 300000,
    });
    if (result.status !== 0) throw new Error(`crAPI compose start exited ${result.status ?? 'unknown'}`);
    return { stop: () => stopCompose(composeFile, target.path), child: undefined };
  }

  const dotGit = path.join(target.path, '.git');
  let addedGitMetadata = false;
  if (!fs.existsSync(dotGit)) {
    const init = runSync('git', ['init', '--quiet'], { cwd: target.path, stdio: 'inherit' });
    if (init.status !== 0) throw new Error(`could not create temporary Git metadata for the allowlisted vulnerable fixture`);
    addedGitMetadata = true;
  }
  console.log('starting_target=vulnerable node test-apps/vulnerable/app.js');
  const child = spawn(process.execPath, ['app.js'], {
    cwd: target.path,
    env: { ...process.env, APP_HOST: '0.0.0.0', PORT: '8787', BASE_URL: 'http://127.0.0.1:8787' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return {
    child,
    stop: () => {
      if (!child.killed) child.kill('SIGTERM');
      if (addedGitMetadata) fs.rmSync(dotGit, { recursive: true, force: true });
    },
  };
}

function stopCompose(composeFile, cwd) {
  const result = runSync('docker', ['compose', '-f', composeFile, 'down', '--remove-orphans'], {
    cwd,
    stdio: 'inherit',
    timeout: 180000,
  });
  if (result.status !== 0) console.error(`WARNING: target teardown exited ${result.status ?? 'unknown'}`);
}

function phaseCommand(target, options) {
  const args = ['start', '--url', target.url, '--repo', target.path, '--config', path.join(ROOT, 'apps/worker/configs/local-runs-sequential.yaml'), '--workspace', options.workspace];
  if (options.profile === 'scheduled') args.push('--no-exploit');
  else {
    args.push('--only', options.phase);
    if (options.phase.startsWith('vuln:')) args.push('--no-exploit');
  }
  return args;
}

function expectedArtifacts(options) {
  if (options.profile === 'scheduled') return ['comprehensive_security_assessment_report.md'];
  if (options.phase === 'pre-recon') return ['pre_recon_deliverable.md'];
  if (options.phase === 'recon') return ['recon_deliverable.md'];
  return ['auth_analysis_deliverable.md'];
}

function resetStalePhaseSession(options) {
  const sessionPath = path.join(WORKSPACES_DIR, options.workspace, 'session.json');
  if (!fs.existsSync(sessionPath) || workerContainers().length > 0) return;
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))?.session;
  } catch {
    return;
  }
  if (!session || !['in-progress', 'failed'].includes(session.status)) return;
  const prerequisite = options.phase === 'recon'
    ? path.join(WORKSPACES_DIR, options.workspace, 'deliverables', 'pre_recon_deliverable.md')
    : options.phase === 'vuln:auth'
      ? path.join(WORKSPACES_DIR, options.workspace, 'deliverables', 'recon_deliverable.md')
      : undefined;
  if (options.phase !== 'pre-recon' && !prerequisite?.length) return;
  if (prerequisite && !fs.existsSync(prerequisite)) return;
  const archived = `${sessionPath}.stale-${Date.now()}`;
  fs.renameSync(sessionPath, archived);
  console.log(`archived_stale_session=${archived}`);
}

function startShannon(target, options, env) {
  const args = phaseCommand(target, options);
  console.log(`shannon_command=./shannon ${args.join(' ')}`);
  const child = spawn('./shannon', args, { cwd: ROOT, env, stdio: 'inherit' });
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

function workerContainers() {
  const result = runSync('docker', ['ps', '-q', '--filter', 'name=^shannon-worker-']);
  return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : [];
}

function stopWorkers(ids) {
  if (ids.length === 0) return;
  const result = runSync('docker', ['stop', ...ids], { stdio: 'inherit', timeout: 60000 });
  if (result.status !== 0) console.error(`WARNING: Shannon worker teardown exited ${result.status ?? 'unknown'}`);
}

async function waitForArtifact(workspace, options) {
  const deliverables = path.join(WORKSPACES_DIR, workspace, 'deliverables');
  const workflowLog = path.join(WORKSPACES_DIR, workspace, 'workflow.log');
  const wanted = expectedArtifacts(options);
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    for (const filename of wanted) {
      const candidate = path.join(deliverables, filename);
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return candidate;
    }
    if (fs.existsSync(workflowLog)) {
      const log = fs.readFileSync(workflowLog, 'utf8');
      if (/\] \[(?:AGENT|WORKFLOW)\].*Failed|Workflow failed/i.test(log)) return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return undefined;
}

function writeDelivery(target, options, artifact, startedAt, status) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportDir = path.join(REPORTS_DIR, `${date}-${target.name}`);
  fs.mkdirSync(reportDir, { recursive: true });
  let summary = { counts: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 }, message: 'Findings summary: no report artifact observed' };
  if (artifact) summary = summarizeReport(fs.readFileSync(artifact, 'utf8'));
  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const delivery = [
    '# Bounded Shannon findings summary',
    '',
    `- Target: ${target.name}`,
    `- Phase: ${options.profile ?? options.phase}`,
    `- Status: ${status}`,
    `- Duration seconds: ${durationSeconds}`,
    `- Artifact observed: ${artifact ?? 'none'}`,
    '',
    summary.message,
    '',
    'This file intentionally contains counts and paths only; raw exploit payloads and report bodies are not copied into delivery.',
    '',
  ].join('\n');
  const summaryPath = path.join(reportDir, 'findings-summary.md');
  fs.writeFileSync(summaryPath, delivery, { mode: 0o640 });
  const ledger = {
    utc: new Date().toISOString(),
    target: target.name,
    phase: options.profile ?? options.phase,
    findings: summary.counts,
    duration_seconds: durationSeconds,
    status,
    artifact: artifact ?? null,
    summary: summaryPath,
  };
  fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(ledger)}\n`, { mode: 0o640 });
  console.log(`findings_summary=${summaryPath}`);
  console.log(`ledger=${LEDGER_PATH}`);
  return summaryPath;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) return;
  const target = resolveTarget(parsed.target);
  const options = {
    ...parsed,
    profile: parsed.profile,
    workspace: parsed.workspace ?? `bounded-${target.name}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
  };
  const args = phaseCommand(target, options);
  if (parsed.dryRun) {
    console.log(`dry_run_target=${target.name}`);
    console.log(`dry_run_command=./shannon ${args.join(' ')}`);
    console.log('dry_run_teardown=target is not started in dry-run mode');
    return;
  }

  const startedAt = Date.now();
  let lifecycle;
  let workersStarted = [];
  let artifact;
  let status = 'failed';
  try {
    await checkModel();
    await checkTemporal();
    lifecycle = startTarget(target);
    await waitForHttp(target.healthUrl, 120);
    const env = {
      ...process.env,
      SHANNON_LOCAL: '1',
      SHANNON_EXECUTOR: 'hermes',
      SHANNON_HERMES_PROVIDER: 'custom',
      SHANNON_HERMES_BASE_URL: WORKER_QUEUE_URL,
      SHANNON_HERMES_MODEL: MODEL_ID,
      SHANNON_HERMES_ALLOW_CONTEXT_FILES: '0',
      SHANNON_HERMES_MAX_ITERATIONS: '25',
      SHANNON_HERMES_TIMEOUT_MS: '600000',
    };
    resetStalePhaseSession(options);
    const workersBefore = new Set(workerContainers());
    const started = await startShannon(target, options, env);
    workersStarted = workerContainers().filter((id) => !workersBefore.has(id));
    console.log(`shannon_exit_code=${started.code ?? 'null'} signal=${started.signal ?? 'none'}`);
    artifact = await waitForArtifact(options.workspace, options);
    status = artifact ? 'completed' : 'workflow_failed_or_timed_out';
  } catch (error) {
    console.error(`run_error=${error.message}`);
  } finally {
    stopWorkers(workersStarted);
    if (lifecycle?.stop) lifecycle.stop();
  }
  writeDelivery(target, options, artifact, startedAt, status);
  if (status !== 'completed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`fatal_error=${error.message}`);
  process.exitCode = 1;
});

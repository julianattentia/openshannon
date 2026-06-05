// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Phase 4 Hermes executor with JSONL streaming.
 *
 * Spawns the Python wrapper (`wrapper.py`), reads its stdout as a stream of
 * newline-delimited events, validates each one with the discriminated-union
 * `HermesEventSchema`, and routes events into Shannon audit logging while
 * accumulating the final `result`/`error` envelope into `ExecutorResult`.
 *
 * Limitations preserved from Phase 3 (lifted in later phases):
 *   - No structured-output support (`outputFormat` still rejected up front).
 *   - No `ErrorCode` mapping into Temporal retry policy (Phase 5).
 *   - No per-agent toolset customization.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditLogger } from '../../audit-logger.js';
import type { AgentExecutor, ExecutorInput, ExecutorResult } from '../types.js';
import { classifyHermesError } from './error-map.js';
import type {
  HermesAssistantMessageEvent,
  HermesErrorEvent,
  HermesEvent,
  HermesResultEvent,
  HermesToolResultEvent,
  HermesToolUseEvent,
} from './events.js';
import { HermesJsonlParser, type ProtocolError } from './parser.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// Phase 9 fix: `code` is not a Hermes toolset (Phase 8 audit). `file` provides
// read_file / write_file / patch / search_files — the actual Read/Edit/Write/Grep
// equivalents Shannon agents need. Overridable via SHANNON_HERMES_TOOLSETS.
const DEFAULT_TOOLSETS = 'terminal,file,web,browser';
const DEFAULT_MAX_ITERATIONS = 500;
const DEFAULT_HEARTBEAT_MS = 20_000;
const PROMPT_TRUNCATE_FOR_LOG = 200;

export interface HermesAgentExecutorOptions {
  pythonBin?: string;
  wrapperPath?: string;
  model?: string;
  provider?: string;
  /** Override OpenAI-compatible base URL (e.g. local llama.cpp / vLLM / LM Studio). */
  baseUrl?: string;
  toolsets?: string;
  maxIterations?: number;
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  mockResult?: string | null;
  mockJsonlTranscript?: string | null;
  env?: NodeJS.ProcessEnv;
  /**
   * Allow Hermes to load `AGENTS.md` / `.cursorrules` from the target repo.
   * **Default: false** (Phase 10 security default). Override via
   * `SHANNON_HERMES_ALLOW_CONTEXT_FILES=1` only when the target is trusted.
   */
  allowContextFiles?: boolean;
}

interface ResolvedOptions {
  pythonBin: string;
  wrapperPath: string;
  toolsets: string;
  maxIterations: number;
  timeoutMs: number;
  heartbeatIntervalMs: number;
  model: string | undefined;
  provider: string | undefined;
  baseUrl: string | undefined;
  mockResult: string | null;
  mockJsonlTranscript: string | null;
  allowContextFiles: boolean;
}

interface StreamOutcome {
  finalEvent: HermesResultEvent | HermesErrorEvent | null;
  protocolError?: ProtocolError | undefined;
  spawnError?: Error | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
  turnsSeen: number;
}

export class HermesAgentExecutor implements AgentExecutor {
  readonly id = 'hermes' as const;
  readonly supportsStructuredOutput = false as const;

  private readonly options: ResolvedOptions;

  constructor(options: HermesAgentExecutorOptions = {}) {
    const env = options.env ?? process.env;
    this.options = {
      pythonBin: options.pythonBin ?? env.SHANNON_HERMES_PYTHON ?? 'python3',
      wrapperPath: options.wrapperPath ?? env.SHANNON_HERMES_WRAPPER ?? defaultWrapperPath(),
      toolsets: options.toolsets ?? env.SHANNON_HERMES_TOOLSETS ?? DEFAULT_TOOLSETS,
      maxIterations:
        options.maxIterations ?? parseIntFromEnv(env.SHANNON_HERMES_MAX_ITERATIONS) ?? DEFAULT_MAX_ITERATIONS,
      timeoutMs: options.timeoutMs ?? parseIntFromEnv(env.SHANNON_HERMES_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
      heartbeatIntervalMs:
        options.heartbeatIntervalMs ?? parseIntFromEnv(env.SHANNON_HERMES_HEARTBEAT_MS) ?? DEFAULT_HEARTBEAT_MS,
      model: options.model ?? env.SHANNON_HERMES_MODEL ?? undefined,
      provider: options.provider ?? env.SHANNON_HERMES_PROVIDER ?? undefined,
      baseUrl: options.baseUrl ?? env.SHANNON_HERMES_BASE_URL ?? undefined,
      mockResult:
        options.mockResult !== undefined
          ? options.mockResult
          : env.SHANNON_HERMES_MOCK_RESULT && env.SHANNON_HERMES_MOCK_RESULT !== ''
            ? env.SHANNON_HERMES_MOCK_RESULT
            : null,
      mockJsonlTranscript:
        options.mockJsonlTranscript !== undefined
          ? options.mockJsonlTranscript
          : env.SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT && env.SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT !== ''
            ? env.SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT
            : null,
      allowContextFiles:
        options.allowContextFiles !== undefined
          ? options.allowContextFiles
          : env.SHANNON_HERMES_ALLOW_CONTEXT_FILES === '1' || env.SHANNON_HERMES_ALLOW_CONTEXT_FILES === 'true',
    };
  }

  async run(input: ExecutorInput): Promise<ExecutorResult> {
    // Hermes does not have native schema-constrained generation. The compatibility
    // path lives in `agent-execution.ts`: it appends a JSON instruction to the
    // prompt and strips `outputFormat` before calling here. Reaching this guard
    // means a caller bypassed that path — fail fast rather than silently drop
    // the schema.
    if (input.outputFormat !== undefined) {
      throw new Error(
        'Hermes executor was called with outputFormat. The structured-output compatibility path in agent-execution.ts must strip outputFormat before invoking Hermes.',
      );
    }

    // Real execution requires model + provider. Mock modes skip this check.
    const isMock = this.options.mockResult !== null || this.options.mockJsonlTranscript !== null;
    if (!isMock && (!this.options.model || !this.options.provider)) {
      throw new Error(
        [
          'Hermes is the default executor in this fork but is not configured.',
          'Either:',
          '  • set SHANNON_HERMES_MODEL and SHANNON_HERMES_PROVIDER (and the matching provider API key in env), or',
          '  • set SHANNON_EXECUTOR=claude to fall back to the Claude executor, or',
          '  • set SHANNON_HERMES_MOCK_RESULT / SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT for tests.',
          'See HERMES_EXECUTOR.md for the full runtime requirements.',
        ].join('\n'),
      );
    }

    const fullPrompt = input.context ? `${input.context}\n\n${input.prompt}` : input.prompt;
    const promptFile = await writeTempPromptFile(fullPrompt);
    // Per-run HERMES_HOME: Hermes caches session/skills state under HERMES_HOME.
    // Empirical observation (Phase 9/10 + local-Qwen smoke): reusing one
    // HERMES_HOME across runs causes stale-state failures (spurious 404s,
    // misrouted requests). Derive a unique subdirectory per executor.run()
    // call. Cleanup is deferred to the OS / operator — diagnostics in
    // HERMES_HOME are often valuable for debugging failed runs.
    const runHermesHome = await this.deriveRunHermesHome(input.agentName ?? 'unnamed');
    const hermesSharedAuthDir = await ensureHermesSharedAuthDir(runHermesHome);
    const startedAt = Date.now();
    const auditLogger = createAuditLogger(input.auditSession);
    let turnCount = 0;

    input.logger?.info(
      `Hermes executor starting${isMock ? (this.options.mockJsonlTranscript ? ' (transcript mock)' : ' (mock mode)') : ''}`,
    );
    await logHermesAuthDiagnostics({
      hermesHome: runHermesHome,
      sharedAuthDir: hermesSharedAuthDir,
      logger: input.logger,
    });

    try {
      const outcome = await this.spawnAndStream({
        promptFile,
        cwd: input.sourceDir,
        hermesHome: runHermesHome,
        hermesSharedAuthDir,
        onEvent: async (event) => {
          turnCount = await routeEvent({
            event,
            auditLogger,
            logger: input.logger,
            turnCount,
          });
        },
      });
      const duration = Date.now() - startedAt;
      const result = await this.shapeResult({
        outcome,
        duration,
        fullPrompt,
        turnCount,
      });
      if (!result.success && result.error) {
        try {
          await auditLogger.logError(new Error(result.error), duration, result.turns ?? turnCount);
        } catch {
          // best-effort audit
        }
      }
      return result;
    } finally {
      await safeUnlink(promptFile);
      input.logger?.info('Hermes executor finished');
    }
  }

  /**
   * Derive a per-run HERMES_HOME under the operator's base directory.
   *
   * Layout: `<base>/<agentName>-<timestamp>-<random>`
   *
   * The base is `process.env.HERMES_HOME` if set (so operators can put it on
   * a fast disk / mounted volume), otherwise `os.tmpdir()/shannon-hermes`.
   * The subdirectory is created eagerly so the wrapper can write session /
   * skills caches into it without racing.
   */
  private async deriveRunHermesHome(agentName: string): Promise<string> {
    const env = process.env;
    const base =
      env.HERMES_HOME && env.HERMES_HOME.trim() !== '' ? env.HERMES_HOME : path.join(os.tmpdir(), 'shannon-hermes');
    const safeAgent = agentName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'agent';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = randomBytes(4).toString('hex');
    const runDir = path.join(base, `${safeAgent}-${stamp}-${rand}`);
    await fs.mkdir(runDir, { recursive: true });

    // Seed config.yaml from the base if present. Operators who configure Hermes
    // via `<base>/config.yaml` get that profile inherited into each per-run dir,
    // while volatile state (sessions, memories, skills) stays isolated.
    let copiedFromBase = false;
    try {
      await fs.copyFile(path.join(base, 'config.yaml'), path.join(runDir, 'config.yaml'));
      copiedFromBase = true;
    } catch {
      // base config.yaml is optional
    }
    await copyIfPresent(path.join(base, 'auth.json'), path.join(runDir, 'auth.json'));
    await copyDirIfPresent(path.join(base, 'shared'), path.join(runDir, 'shared'));

    // If no base config.yaml is present and the operator gave us provider/model
    // via env (e.g. inside the Docker worker container), synthesize a minimal
    // config.yaml on the fly. Hermes 0.14.0 requires a config.yaml to resolve
    // the `custom` / aliased provider names; the `base_url` kwarg alone is not
    // enough. This keeps the CLI launch path env-only.
    if (!copiedFromBase) {
      const provider = this.options.provider;
      const model = this.options.model;
      const baseUrl = this.options.baseUrl;
      if (provider && model && baseUrl) {
        const yaml = [
          'providers:',
          `  ${provider}:`,
          '    provider: openai',
          '    api_mode: chat_completions',
          `    base_url: ${baseUrl}`,
          '    api_key_env: OPENAI_API_KEY',
          'model:',
          `  default: ${model}`,
          `  provider: ${provider}`,
          `  base_url: ${baseUrl}`,
          '',
        ].join('\n');
        try {
          await fs.writeFile(path.join(runDir, 'config.yaml'), yaml, 'utf8');
        } catch {
          // best-effort; if write fails the wrapper will surface a clear error
        }
      }
    }

    return runDir;
  }

  private async spawnAndStream(args: {
    promptFile: string;
    cwd: string;
    hermesHome: string;
    hermesSharedAuthDir: string;
    onEvent: (event: HermesEvent) => Promise<void>;
  }): Promise<StreamOutcome> {
    const argv = this.buildArgs(args.promptFile, args.cwd);
    const parser = new HermesJsonlParser();
    let stderrBuffer = '';
    let protocolError: ProtocolError | undefined;
    const eventQueue: Promise<void> = Promise.resolve();
    let queue = eventQueue;
    let aborted = false;

    return new Promise<StreamOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.options.pythonBin, argv, {
          cwd: args.cwd,
          env: {
            ...process.env,
            HERMES_HOME: args.hermesHome,
            HERMES_SHARED_AUTH_DIR: args.hermesSharedAuthDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (spawnError) {
        resolve({
          finalEvent: null,
          spawnError: spawnError instanceof Error ? spawnError : new Error(String(spawnError)),
          exitCode: null,
          signal: null,
          timedOut: false,
          stderr: '',
          turnsSeen: 0,
        });
        return;
      }

      let turnsSeen = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, this.options.timeoutMs);

      const handleChunk = (chunk: Buffer) => {
        if (aborted) return;
        const { events, protocolError: pe } = parser.feed(chunk.toString('utf8'));
        for (const event of events) {
          if (event.type === 'assistant_message') turnsSeen += 1;
          queue = queue.then(() => args.onEvent(event)).catch(() => undefined);
        }
        if (pe && !protocolError) {
          protocolError = pe;
          aborted = true;
          if (!child.killed) child.kill('SIGKILL');
        }
      };

      child.stdout?.on('data', handleChunk);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString('utf8');
      });

      const finalize = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        clearTimeout(timer);
        // Drain any partial buffered line.
        if (!protocolError) {
          const { events, protocolError: pe } = parser.flush();
          for (const event of events) {
            queue = queue.then(() => args.onEvent(event)).catch(() => undefined);
          }
          if (pe) protocolError = pe;
        }
        queue.then(() => {
          resolve({
            finalEvent: parser.finalEventSeen() as HermesResultEvent | HermesErrorEvent | null,
            protocolError,
            spawnError,
            exitCode: code,
            signal,
            timedOut,
            stderr: stderrBuffer,
            turnsSeen,
          });
        });
      };

      child.on('error', (err) => finalize(null, null, err));
      child.on('close', (code, signal) => finalize(code, signal));
    });
  }

  private buildArgs(promptFile: string, cwd: string): string[] {
    const argv: string[] = [
      this.options.wrapperPath,
      '--cwd',
      cwd,
      '--prompt-file',
      promptFile,
      '--toolsets',
      this.options.toolsets,
      '--max-iterations',
      String(this.options.maxIterations),
      '--heartbeat-interval-ms',
      String(this.options.heartbeatIntervalMs),
    ];
    if (this.options.model) argv.push('--model', this.options.model);
    if (this.options.provider) argv.push('--provider', this.options.provider);
    if (this.options.baseUrl) argv.push('--base-url', this.options.baseUrl);
    if (this.options.allowContextFiles) argv.push('--allow-context-files');
    if (this.options.mockJsonlTranscript !== null) {
      argv.push('--mock-jsonl-transcript', this.options.mockJsonlTranscript);
    } else if (this.options.mockResult !== null) {
      argv.push('--mock-result', this.options.mockResult);
    }
    return argv;
  }

  private async shapeResult(args: {
    outcome: StreamOutcome;
    duration: number;
    fullPrompt: string;
    turnCount: number;
  }): Promise<ExecutorResult> {
    const { outcome, duration, fullPrompt, turnCount } = args;
    const turnsObserved = outcome.turnsSeen || turnCount;
    const promptForLog = truncate(fullPrompt, PROMPT_TRUNCATE_FOR_LOG);

    // Successful final event — happy path.
    if (
      outcome.finalEvent?.type === 'result' &&
      outcome.finalEvent.success &&
      !outcome.protocolError &&
      !outcome.timedOut &&
      !outcome.spawnError
    ) {
      const event = outcome.finalEvent;
      return {
        success: true,
        duration,
        cost: event.cost,
        result: event.result ?? null,
        turns: event.turns ?? turnsObserved,
        model: event.model ?? undefined,
      };
    }

    // Failure path: synthesize a single classifier input from every available signal.
    const finalEvent = outcome.finalEvent;
    // Filter benign Hermes startup warnings (optional-dep import notices) from
    // the stderr we feed to the classifier. Lines like:
    //   `Could not import tool module tools.browser_dialog_tool: No module named 'websockets'`
    // are normal when an optional Hermes toolset's deps aren't installed, but
    // would otherwise text-match the `wrapper_dependency_error` regex and
    // force-misclassify retryable failures as non-retryable. (Phase 13 Trial 1A
    // root cause.)
    const stderrText = outcome.stderr
      .split('\n')
      .filter((line) => !/^Could not import tool module /.test(line.trim()))
      .filter((line) => !/^\[HERMES_HOME fallback\]/.test(line.trim()))
      .join('\n')
      .trim()
      .slice(0, 1000);
    const explicitErrorType =
      finalEvent && (finalEvent.type === 'result' || finalEvent.type === 'error')
        ? (finalEvent.error_type ?? null)
        : null;
    const explicitRetryable =
      finalEvent && (finalEvent.type === 'result' || finalEvent.type === 'error')
        ? (finalEvent.retryable ?? null)
        : null;
    const eventError =
      finalEvent && (finalEvent.type === 'result' || finalEvent.type === 'error') ? (finalEvent.error ?? null) : null;
    const localError =
      outcome.protocolError?.message ??
      (outcome.spawnError ? `Hermes wrapper failed to spawn: ${outcome.spawnError.message}` : null) ??
      (outcome.timedOut ? `Hermes wrapper timed out after ${this.options.timeoutMs}ms` : null) ??
      (finalEvent === null
        ? outcome.exitCode !== 0
          ? `Hermes wrapper exited with code ${outcome.exitCode} before emitting a final event.`
          : 'Hermes wrapper exited without emitting a final event.'
        : null);

    const classified = classifyHermesError({
      error: eventError ?? localError,
      errorType: explicitErrorType,
      wrapperRetryable: explicitRetryable,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: stderrText,
      timedOut: outcome.timedOut,
      protocolError: outcome.protocolError !== undefined,
      spawnFailed: outcome.spawnError !== undefined,
      missingFinalEvent: finalEvent === null,
    });

    const cost = finalEvent && (finalEvent.type === 'result' || finalEvent.type === 'error') ? finalEvent.cost : 0;
    const turns =
      finalEvent && (finalEvent.type === 'result' || finalEvent.type === 'error')
        ? (finalEvent.turns ?? turnsObserved)
        : turnsObserved;
    const model =
      finalEvent && (finalEvent.type === 'result' || finalEvent.type === 'error')
        ? (finalEvent.model ?? undefined)
        : undefined;
    const partialResult = finalEvent?.type === 'result' ? (finalEvent.result ?? null) : null;

    return {
      success: false,
      duration,
      cost,
      result: partialResult,
      turns,
      model,
      error: eventError ?? localError ?? classified.normalizedMessage,
      errorType: classified.errorType,
      retryable: classified.retryable,
      prompt: promptForLog,
    };
  }
}

interface RouteEventArgs {
  event: HermesEvent;
  auditLogger: ReturnType<typeof createAuditLogger>;
  logger: ExecutorInput['logger'];
  turnCount: number;
}

async function routeEvent({ event, auditLogger, logger, turnCount }: RouteEventArgs): Promise<number> {
  switch (event.type) {
    case 'session_start':
      logger?.info(`Hermes session start (model=${event.model ?? 'unknown'} provider=${event.provider ?? 'unknown'})`);
      return turnCount;
    case 'assistant_delta':
      // Deltas are progress-only in Phase 4 — not routed to audit to avoid
      // log spam. Phase 5+ may surface them as progress updates.
      return turnCount;
    case 'assistant_message': {
      const msg = event as HermesAssistantMessageEvent;
      const nextTurn = turnCount + 1;
      await auditLogger.logLlmResponse(nextTurn, msg.text);
      return nextTurn;
    }
    case 'tool_use': {
      const tool = event as HermesToolUseEvent;
      await auditLogger.logToolStart(tool.name, tool.input);
      return turnCount;
    }
    case 'tool_result': {
      const tool = event as HermesToolResultEvent;
      await auditLogger.logToolEnd(tool.content ?? null);
      return turnCount;
    }
    case 'heartbeat':
      // Progress/liveness only — Shannon's Temporal activity heartbeat is
      // currently driven by `runClaudePrompt`; bridging it to Hermes lives
      // outside the executor surface and is Phase 5+ work.
      return turnCount;
    case 'result':
    case 'error':
      // Final events are handled in `shapeResult` after the stream closes.
      return turnCount;
  }
}

function defaultWrapperPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..', 'src', 'ai', 'executor', 'hermes', 'wrapper.py');
}

async function writeTempPromptFile(prompt: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shannon-hermes-'));
  const file = path.join(dir, 'prompt.txt');
  await fs.writeFile(file, prompt, { encoding: 'utf8', mode: 0o600 });
  return file;
}

async function safeUnlink(file: string): Promise<void> {
  try {
    await fs.unlink(file);
    await fs.rmdir(path.dirname(file));
  } catch {
    // best effort
  }
}

async function ensureHermesSharedAuthDir(hermesHome: string): Promise<string> {
  const sharedAuthDir = path.join(path.dirname(hermesHome), 'shared');
  await fs.mkdir(sharedAuthDir, { recursive: true, mode: 0o700 });
  return sharedAuthDir;
}

async function logHermesAuthDiagnostics(args: {
  hermesHome: string;
  sharedAuthDir: string;
  logger: ExecutorInput['logger'];
}): Promise<void> {
  const { hermesHome, sharedAuthDir, logger } = args;
  if (!logger) return;

  const authPath = path.join(hermesHome, 'auth.json');
  const sharedNousPath = path.join(sharedAuthDir, 'nous_auth.json');
  const localSharedNousPath = path.join(hermesHome, 'shared', 'nous_auth.json');

  const [authFile, sharedNousFile, localSharedNousFile] = await Promise.all([
    describeJsonFile(authPath, summarizeHermesAuthJson),
    describeJsonFile(sharedNousPath, summarizeNousSharedJson),
    describeJsonFile(localSharedNousPath, summarizeNousSharedJson),
  ]);

  logger.info(
    `Hermes auth diagnostics: home=${hermesHome} sharedAuthDir=${sharedAuthDir} ` +
      `auth=${formatFileSummary(authFile)} sharedNous=${formatFileSummary(sharedNousFile)} ` +
      `localSharedNous=${formatFileSummary(localSharedNousFile)}`,
  );
}

interface JsonFileSummary {
  path: string;
  exists: boolean;
  mtime?: string;
  size?: number;
  summary?: Record<string, unknown>;
  error?: string;
}

async function describeJsonFile(
  file: string,
  summarize: (value: unknown) => Record<string, unknown>,
): Promise<JsonFileSummary> {
  try {
    const stat = await fs.stat(file);
    let summary: Record<string, unknown> | undefined;
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      summary = summarize(value);
    } catch (err) {
      return {
        path: file,
        exists: true,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      path: file,
      exists: true,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
      summary,
    };
  } catch {
    return { path: file, exists: false };
  }
}

function summarizeHermesAuthJson(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  const providers = asRecord(root.providers);
  const nous = asRecord(providers.nous);
  const pool = asRecord(root.credential_pool);
  const nousPool = Array.isArray(pool.nous) ? pool.nous : [];
  const lastAuthError = asRecord(nous.last_auth_error);
  return compactRecord({
    activeProvider: stringOrUndefined(root.active_provider),
    hasNousProvider: Object.keys(nous).length > 0,
    nousFields: Object.keys(nous).filter((key) => !secretishKey(key)).sort(),
    expiresAt: stringOrUndefined(nous.expires_at),
    agentKeyExpiresAt: stringOrUndefined(nous.agent_key_expires_at),
    inferenceBaseUrl: stringOrUndefined(nous.inference_base_url),
    portalBaseUrl: stringOrUndefined(nous.portal_base_url),
    poolEntries: nousPool.length,
    lastAuthError: Object.keys(lastAuthError).length
      ? compactRecord({
          code: stringOrUndefined(lastAuthError.code),
          reason: stringOrUndefined(lastAuthError.reason),
          reloginRequired: booleanOrUndefined(lastAuthError.relogin_required),
          at: stringOrUndefined(lastAuthError.at),
        })
      : undefined,
    updatedAt: stringOrUndefined(root.updated_at),
  });
}

function summarizeNousSharedJson(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  return compactRecord({
    hasAccessToken: typeof root.access_token === 'string' && root.access_token.length > 0,
    hasRefreshToken: typeof root.refresh_token === 'string' && root.refresh_token.length > 0,
    expiresAt: stringOrUndefined(root.expires_at),
    inferenceBaseUrl: stringOrUndefined(root.inference_base_url),
    portalBaseUrl: stringOrUndefined(root.portal_base_url),
    updatedAt: stringOrUndefined(root.updated_at),
  });
}

function formatFileSummary(file: JsonFileSummary): string {
  if (!file.exists) return `${file.path}:missing`;
  const details = compactRecord({
    mtime: file.mtime,
    size: file.size,
    error: file.error,
    ...(file.summary ?? {}),
  });
  return `${file.path}:${JSON.stringify(details)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function secretishKey(key: string): boolean {
  return /token|key|secret|authorization|password/i.test(key);
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  } catch {
    // Optional operator-provided Hermes state.
  }
}

async function copyDirIfPresent(from: string, to: string): Promise<void> {
  try {
    await fs.cp(from, to, { recursive: true });
  } catch {
    // Optional operator-provided Hermes state.
  }
}

function parseIntFromEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

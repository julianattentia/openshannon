// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Executor selection.
 *
 * Selection precedence:
 *   1. explicit `executorId` argument (typically threaded from config)
 *   2. `SHANNON_EXECUTOR` env var
 *   3. default: `DEFAULT_EXECUTOR` (Phase 10: Hermes)
 *
 * Phase 10 flipped the default from Claude to Hermes. Claude remains
 * available as an explicit fallback via `SHANNON_EXECUTOR=claude`. There is
 * no silent fallback between executors in either direction — Hermes failures
 * bubble through Temporal retry; Claude failures do the same.
 */

import type { ActivityLogger } from '../../types/activity-logger.js';
import { ClaudeAgentExecutor } from './claude/executor.js';
import { HermesAgentExecutor, type HermesAgentExecutorOptions } from './hermes/executor.js';
import type { AgentExecutor, ExecutorId } from './types.js';

/** Single source of truth for the default executor. Flip to roll the default back. */
export const DEFAULT_EXECUTOR: ExecutorId = 'hermes';

const KNOWN_EXECUTOR_IDS: readonly ExecutorId[] = ['claude', 'hermes'];

export interface SelectAgentExecutorOptions {
  /**
   * Explicit executor id. Wins over the environment when provided.
   * `null`/`undefined`/empty string fall through to env, then default.
   */
  executorId?: ExecutorId | string | null | undefined;
  logger?: ActivityLogger | undefined;
  /**
   * Test seam — defaults to `process.env`. Production callers should not pass this.
   */
  env?: NodeJS.ProcessEnv | undefined;
  /** Optional Hermes executor overrides (constructor args win over env). */
  hermes?: HermesAgentExecutorOptions | undefined;
}

/**
 * Resolve the executor id from the explicit option, then env, then default.
 * Returns a validated `ExecutorId` or throws on an unknown value.
 */
export function resolveExecutorId(options: SelectAgentExecutorOptions = {}): ExecutorId {
  const env = options.env ?? process.env;
  const fromArg = normalizeRaw(options.executorId);
  const fromEnv = normalizeRaw(env.SHANNON_EXECUTOR);
  const raw = fromArg ?? fromEnv;

  if (raw === null) {
    return DEFAULT_EXECUTOR;
  }

  if (isExecutorId(raw)) {
    return raw;
  }

  throw new Error(`Unsupported agent executor: "${raw}". Expected one of: ${KNOWN_EXECUTOR_IDS.join(', ')}.`);
}

/**
 * Construct the selected executor. Defaults to Claude.
 *
 * @throws if the resolved id is unknown.
 */
export function selectAgentExecutor(options: SelectAgentExecutorOptions = {}): AgentExecutor {
  const id = resolveExecutorId(options);

  switch (id) {
    case 'claude': {
      const executor = new ClaudeAgentExecutor();
      options.logger?.info('Selected agent executor: claude');
      return executor;
    }
    case 'hermes': {
      const hermesOptions: HermesAgentExecutorOptions = { ...(options.hermes ?? {}) };
      if (options.env !== undefined && hermesOptions.env === undefined) {
        hermesOptions.env = options.env;
      }
      const executor = new HermesAgentExecutor(hermesOptions);
      options.logger?.info('Selected agent executor: hermes');
      return executor;
    }
  }
}

function normalizeRaw(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

function isExecutorId(value: string): value is ExecutorId {
  return (KNOWN_EXECUTOR_IDS as readonly string[]).includes(value);
}

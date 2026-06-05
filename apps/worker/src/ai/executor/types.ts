// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Generic agent-executor boundary.
 *
 * Phase 1 introduces this interface around the existing Claude execution path
 * without changing any behavior. Only the Claude executor is wired up today;
 * additional executors are introduced in later phases.
 */

import type { JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';
import type { AuditSession } from '../../audit/index.js';
import type { ActivityLogger } from '../../types/activity-logger.js';
import type { ProviderConfig } from '../../types/config.js';
import type { ModelTier } from '../models.js';

/**
 * Inputs for a single agent execution.
 *
 * Field shape and semantics are intentionally identical to the positional
 * arguments of `runClaudePrompt` so the Phase 1 wrapper is a pure boundary.
 */
export interface ExecutorInput {
  prompt: string;
  sourceDir: string;
  context?: string;
  description?: string;
  agentName: string | null;
  auditSession: AuditSession | null;
  logger: ActivityLogger;
  modelTier?: ModelTier | undefined;
  outputFormat?: JsonSchemaOutputFormat | undefined;
  apiKey?: string | undefined;
  deliverablesSubdir?: string | undefined;
  providerConfig?: ProviderConfig | undefined;
  /**
   * In-process MCP servers (e.g. structured-output collectors). Forwarded to
   * the Claude Agent SDK by the Claude executor. The Hermes executor has no
   * SDK MCP channel and ignores this field.
   */
  mcpServers?: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> | undefined;
}

/**
 * Result of a single agent execution.
 *
 * Structurally compatible with the existing `ClaudePromptResult` so callers
 * can be migrated to the executor boundary without behavioral changes.
 */
export interface ExecutorResult {
  result?: string | null | undefined;
  success: boolean;
  duration: number;
  turns?: number | undefined;
  cost: number;
  model?: string | undefined;
  partialCost?: number | undefined;
  apiErrorDetected?: boolean | undefined;
  error?: string | undefined;
  errorType?: string | undefined;
  prompt?: string | undefined;
  retryable?: boolean | undefined;
  structuredOutput?: unknown;
}

export type ExecutorId = 'claude' | 'hermes';

/**
 * Executor selection configuration.
 *
 * Phase 2 introduces this type for future config-file integration. Today the
 * selector reads `SHANNON_EXECUTOR` from the environment; this shape is the
 * forward-compatible config entry that a later phase can plumb through.
 */
export interface ExecutorConfig {
  readonly id?: ExecutorId;
}

export interface AgentExecutor {
  readonly id: ExecutorId;
  readonly supportsStructuredOutput: boolean;
  run(input: ExecutorInput): Promise<ExecutorResult>;
}

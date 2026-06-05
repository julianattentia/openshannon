// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Claude executor — thin wrapper around `runClaudePrompt`.
 *
 * Phase 1 boundary layer: delegates verbatim. No argument values, defaults,
 * env handling, output format, audit, or error handling change here.
 */

import { runClaudePrompt } from '../../claude-executor.js';
import type { AgentExecutor, ExecutorInput, ExecutorResult } from '../types.js';

export class ClaudeAgentExecutor implements AgentExecutor {
  readonly id = 'claude' as const;
  readonly supportsStructuredOutput = true as const;

  async run(input: ExecutorInput): Promise<ExecutorResult> {
    return runClaudePrompt(
      input.prompt,
      input.sourceDir,
      input.context ?? '',
      input.description ?? 'Claude analysis',
      input.agentName,
      input.auditSession,
      input.logger,
      input.modelTier ?? 'medium',
      input.outputFormat,
      input.apiKey,
      input.deliverablesSubdir,
      input.providerConfig,
      input.mcpServers,
    );
  }
}

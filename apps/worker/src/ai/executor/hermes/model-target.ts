// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Per-agent Hermes model-target resolution.
 *
 * Lets the operator freely configure which model runs which agent. A config
 * `hermes_models` map defines named targets ("model types"); `agent_models`
 * assigns agents (or the literal `default`) to those labels. Hermes-routed
 * agents not covered by config fall back to the single `SHANNON_HERMES_*` env
 * target — so existing single-model runs are unchanged.
 */

import type { HermesModelTarget } from '../../../types/config.js';

/** Subset of HermesAgentExecutorOptions this resolver populates. */
export interface ResolvedHermesTarget {
  model?: string;
  provider?: string;
  baseUrl?: string;
}

/**
 * Resolve the Hermes (provider, model, base_url) for a single agent.
 *
 * Precedence: `agent_models[agent]` label → `agent_models.default` label →
 * single `SHANNON_HERMES_{MODEL,PROVIDER,BASE_URL}` env. Pure — `env` is
 * injected so it can be unit-tested without touching process state.
 */
export function resolveHermesTargetForAgent(opts: {
  agentName: string;
  hermesModels: Record<string, HermesModelTarget>;
  agentModels: Record<string, string>;
  env: NodeJS.ProcessEnv;
}): ResolvedHermesTarget {
  const { agentName, hermesModels, agentModels, env } = opts;

  const label = agentModels[agentName] ?? agentModels.default;
  const target = label ? hermesModels[label] : undefined;

  // Per-field fallback to the single-env target, so a partial named target
  // (e.g. only `model`) inherits the rest from SHANNON_HERMES_*.
  const provider = target?.provider ?? env.SHANNON_HERMES_PROVIDER;
  const model = target?.model ?? env.SHANNON_HERMES_MODEL;
  const baseUrl = target?.base_url ?? env.SHANNON_HERMES_BASE_URL;

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Phase 5 Hermes error classification.
 *
 * Single source of truth for mapping wrapper / provider / transport errors
 * into the stable `errorType` + `retryable` pair that lands on
 * `ExecutorResult`. The classifier:
 *
 *   1. Honors an explicit, *known* `errorType` from the wrapper.
 *   2. Honors local outcome flags (timeout, protocol error, spawn failure)
 *      *before* text classification.
 *   3. Falls back to regex matching on the error message + stderr.
 *   4. Returns a generic `unknown_provider_error` (retryable) when the model
 *      side reported a failure we can't recognize, but
 *      `unknown_wrapper_error` (non-retryable) when the local side did.
 *
 * Error categories are deliberately exhaustive (Phase 5 brief). They map
 * conceptually onto Shannon's existing `ErrorCode` enum but stay as
 * stable string values on `ExecutorResult` so the executor layer doesn't
 * need to import `ErrorCode`.
 */

/** Stable machine-readable error categories surfaced on `ExecutorResult.errorType`. */
export const HERMES_ERROR_TYPES = [
  // Provider / API failures (network).
  'rate_limit',
  'server_error',
  'authentication_failed',
  'model_not_found',
  'billing_error',
  'invalid_provider_config',
  'max_iterations',
  'unknown_provider_error',
  // Local execution failures (wrapper / subprocess).
  'timeout',
  'wrapper_protocol_error',
  'wrapper_process_error',
  'wrapper_dependency_error',
  'wrapper_input_error',
  'unknown_wrapper_error',
  // Hermes-specific runtime failures that aren't clearly provider vs local.
  'hermes_runtime_error',
  'hermes_import_failed',
] as const;

export type HermesErrorType = (typeof HERMES_ERROR_TYPES)[number];

const KNOWN_ERROR_TYPES: ReadonlySet<string> = new Set(HERMES_ERROR_TYPES);

const RETRYABLE_BY_TYPE: Readonly<Record<HermesErrorType, boolean>> = {
  // Provider / API
  rate_limit: true,
  server_error: true,
  authentication_failed: false,
  model_not_found: false,
  billing_error: true,
  invalid_provider_config: false,
  max_iterations: true,
  unknown_provider_error: true,
  // Local
  timeout: true,
  wrapper_protocol_error: false,
  wrapper_process_error: false,
  wrapper_dependency_error: false,
  wrapper_input_error: false,
  unknown_wrapper_error: false,
  // Hermes runtime
  hermes_runtime_error: true,
  hermes_import_failed: false,
};

export interface ClassifyHermesErrorInput {
  /** Error message from the wrapper's final `error` / `result` event, or the failure synthesized by the Node side. */
  error?: string | null | undefined;
  /** Explicit error type from the wrapper. Honored if it is a recognised `HermesErrorType`. */
  errorType?: string | null | undefined;
  /** Explicit retryable flag from the wrapper. Honored when paired with a known errorType. */
  wrapperRetryable?: boolean | null | undefined;
  /** Subprocess exit code (Node side). */
  exitCode?: number | null | undefined;
  /** Subprocess termination signal. */
  signal?: NodeJS.Signals | null | undefined;
  /** Captured stderr (Node side); searched as a fallback for text classification. */
  stderr?: string | undefined;
  /** Node-side timeout fired. */
  timedOut?: boolean | undefined;
  /** Node-side parser flagged a protocol error. */
  protocolError?: boolean | undefined;
  /** Subprocess failed to spawn (e.g. `ENOENT`). */
  spawnFailed?: boolean | undefined;
  /** No final event was observed before EOF. */
  missingFinalEvent?: boolean | undefined;
}

export interface ClassifiedHermesError {
  errorType: HermesErrorType;
  retryable: boolean;
  normalizedMessage: string;
}

interface TextRule {
  match: RegExp;
  errorType: HermesErrorType;
}

// Ordered: more-specific patterns first. First match wins.
const TEXT_RULES: readonly TextRule[] = [
  { match: /\b(rate.?limit|too.?many.?requests|http\s*429|\b429\b)\b/i, errorType: 'rate_limit' },
  { match: /\b(timeout|timed.?out|deadline.*exceeded)\b/i, errorType: 'timeout' },
  {
    match:
      /\b(unauthorized|invalid.*api.*key|api.*key.*invalid|http\s*401|\b401\b|http\s*403|\b403\b|forbidden|authentication)\b/i,
    errorType: 'authentication_failed',
  },
  { match: /\b(model.*not.*found|no.*such.*model|unknown.*model|model.*unavailable)\b/i, errorType: 'model_not_found' },
  {
    match:
      /\b(quota|billing|credit|insufficient.*fund|insufficient.*credit|payment.*required|http\s*402|\b402\b|spending.*cap)\b/i,
    errorType: 'billing_error',
  },
  {
    match: /\b(invalid.*provider|unknown.*provider|provider.*not.*configured|provider.*not.*found)\b/i,
    errorType: 'invalid_provider_config',
  },
  { match: /\b(max.?iterations?|iterations?.*limit|max.*turns?|turns?.*limit)\b/i, errorType: 'max_iterations' },
  {
    match: /\b(modulenotfounderror|importerror|no.*module.*named|cannot.*import|failed.*to.*import)\b/i,
    errorType: 'wrapper_dependency_error',
  },
  {
    match:
      /\b(5\d\d\b|http\s*5\d\d|server.?error|service.*unavailable|temporarily.*unavailable|bad.?gateway|gateway.?timeout|internal.?server.?error)\b/i,
    errorType: 'server_error',
  },
];

/**
 * Classify a Hermes outcome into a stable error type + retryable flag.
 *
 * Returns `{ errorType: 'unknown_wrapper_error', retryable: false, ... }` when
 * none of the inputs identify the failure — this is the safe default for a
 * local executor that should not be retried indefinitely.
 */
export function classifyHermesError(input: ClassifyHermesErrorInput = {}): ClassifiedHermesError {
  const messageParts: string[] = [];
  if (input.error) messageParts.push(input.error);
  if (input.stderr?.trim()) messageParts.push(input.stderr.trim());
  const normalizedMessage = messageParts.join(' | ').slice(0, 1000);

  // 1. Local outcome flags beat any wrapper claim — these are observed by Node.
  if (input.timedOut) {
    return result('timeout', normalizedMessage || `Hermes wrapper timed out`);
  }
  if (input.protocolError) {
    return result('wrapper_protocol_error', normalizedMessage || 'Hermes wrapper protocol error');
  }
  if (input.spawnFailed) {
    return result('wrapper_process_error', normalizedMessage || 'Hermes wrapper failed to spawn');
  }

  // 2. Explicit wrapper errorType — honored only when recognized.
  const explicit = normalizeType(input.errorType);
  if (explicit !== null) {
    const retryable =
      typeof input.wrapperRetryable === 'boolean' ? input.wrapperRetryable : RETRYABLE_BY_TYPE[explicit];
    return {
      errorType: explicit,
      retryable,
      normalizedMessage: normalizedMessage || `Hermes ${explicit}`,
    };
  }

  // 3. Text classification.
  const haystack = normalizedMessage;
  if (haystack) {
    for (const rule of TEXT_RULES) {
      if (rule.match.test(haystack)) {
        return result(rule.errorType, normalizedMessage);
      }
    }
  }

  // 4. Process-level fallbacks.
  if (input.missingFinalEvent) {
    return result('wrapper_process_error', normalizedMessage || 'Hermes wrapper exited before emitting a final event');
  }
  if (typeof input.exitCode === 'number' && input.exitCode !== 0) {
    return result('wrapper_process_error', normalizedMessage || `Hermes wrapper exited with code ${input.exitCode}`);
  }
  if (input.signal) {
    return result('wrapper_process_error', normalizedMessage || `Hermes wrapper terminated by signal ${input.signal}`);
  }

  // 5. Unknown — preserve provenance: model-side text (input.error present) vs purely local.
  const fallbackType: HermesErrorType = input.error ? 'unknown_provider_error' : 'unknown_wrapper_error';
  return result(fallbackType, normalizedMessage || 'Hermes failure with no identifiable cause');
}

function result(errorType: HermesErrorType, normalizedMessage: string): ClassifiedHermesError {
  return { errorType, retryable: RETRYABLE_BY_TYPE[errorType], normalizedMessage };
}

function normalizeType(raw: string | null | undefined): HermesErrorType | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return KNOWN_ERROR_TYPES.has(trimmed) ? (trimmed as HermesErrorType) : null;
}

export function isRetryableHermesErrorType(errorType: HermesErrorType): boolean {
  return RETRYABLE_BY_TYPE[errorType];
}

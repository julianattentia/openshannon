/**
 * Environment variable loading and credential validation.
 *
 * Local mode: loads ./.env via dotenv.
 * NPX mode: fills gaps from ~/.shannon/config.toml (no .env).
 */

import dotenv from 'dotenv';
import { resolveConfig } from './config/resolver.js';
import { getMode } from './mode.js';

/**
 * Environment variables forwarded to worker containers.
 *
 * Three groups:
 *   1. Executor selection (Hermes-by-default in this fork; SHANNON_EXECUTOR=claude for fallback).
 *   2. Hermes runtime configuration (SHANNON_HERMES_*, HERMES_HOME, HERMES_E2E).
 *   3. Provider credentials shared with both executors (Anthropic / OpenAI-compatible / OpenRouter / AWS / GCP).
 *
 * Values are forwarded only when set in the host environment — never defaulted here.
 */
const FORWARD_VARS = [
  // --- Executor selection ---
  'SHANNON_EXECUTOR',

  // --- Hermes runtime ---
  'SHANNON_HERMES_PYTHON',
  'SHANNON_HERMES_WRAPPER',
  'SHANNON_HERMES_PROVIDER',
  'SHANNON_HERMES_MODEL',
  'SHANNON_HERMES_BASE_URL',
  'SHANNON_HERMES_TOOLSETS',
  'SHANNON_HERMES_MAX_ITERATIONS',
  'SHANNON_HERMES_TIMEOUT_MS',
  'SHANNON_HERMES_HEARTBEAT_MS',
  'SHANNON_HERMES_HEARTBEAT_INTERVAL_MS',
  'SHANNON_HERMES_ALLOW_CONTEXT_FILES',
  'SHANNON_HERMES_MOCK_RESULT',
  'SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT',
  'HERMES_HOME',
  'HERMES_SEED_DIR',
  'HERMES_E2E',

  // --- Anthropic / Claude (legacy default; still required when SHANNON_EXECUTOR=claude) ---
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_SMALL_MODEL',
  'ANTHROPIC_MEDIUM_MODEL',
  'ANTHROPIC_LARGE_MODEL',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_ADAPTIVE_THINKING',

  // --- OpenAI-compatible (local llama.cpp / vLLM / LM Studio) and OpenRouter ---
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API',

  // --- AWS (shared with Bedrock; also generic) ---
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

/**
 * Load credentials into process.env.
 * Local mode: loads ./.env via dotenv.
 * NPX mode: fills gaps from ~/.shannon/config.toml.
 * Exported env vars always take precedence in both modes.
 */
export function loadEnv(): void {
  if (getMode() === 'local') {
    dotenv.config({ path: '.env', quiet: true });
  } else {
    resolveConfig();
  }
}

/**
 * Build `-e KEY=VALUE` flags for docker run, only for set variables.
 */
export function buildEnvFlags(): string[] {
  const flags: string[] = ['-e', 'TEMPORAL_ADDRESS=shannon-temporal:7233'];

  for (const key of FORWARD_VARS) {
    const value = process.env[key];
    if (value) {
      flags.push('-e', `${key}=${value}`);
    }
  }

  return flags;
}

interface CredentialValidation {
  valid: boolean;
  error?: string;
  mode: 'api-key' | 'oauth' | 'custom-base-url' | 'bedrock' | 'vertex' | 'hermes-mock' | 'hermes-real';
}

/**
 * Resolve the configured executor. Mirrors `selectAgentExecutor` precedence:
 * env override, then the default (Phase 10: Hermes). Returns one of
 * `'hermes'` / `'claude'` or null if the value is invalid — callers should
 * surface the invalid value as an actionable error.
 */
function resolveExecutor(): 'hermes' | 'claude' | null {
  const raw = (process.env.SHANNON_EXECUTOR ?? '').trim().toLowerCase();
  if (raw === '') return 'hermes';
  if (raw === 'hermes' || raw === 'claude') return raw;
  return null;
}

/** Hermes-side credential validation — accepts any of mock, real-provider, or BYOK-style configs. */
function validateHermesCredentials(): CredentialValidation {
  const env = process.env;

  // Mock modes — no real provider needed.
  if (env.SHANNON_HERMES_MOCK_RESULT || env.SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT) {
    return { valid: true, mode: 'hermes-mock' };
  }

  const provider = (env.SHANNON_HERMES_PROVIDER ?? '').trim();
  const model = (env.SHANNON_HERMES_MODEL ?? '').trim();

  if (!provider || !model) {
    return {
      valid: false,
      mode: 'hermes-real',
      error: [
        'Hermes is selected, but no Hermes runtime/model configuration was found.',
        '',
        'Set one of:',
        '  - SHANNON_HERMES_MOCK_RESULT="..."                       (mock mode, no API)',
        '  - SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT=/path/to.jsonl    (mock mode, replays JSONL)',
        '  - SHANNON_HERMES_PROVIDER=<openrouter|anthropic|openai|custom|...> and SHANNON_HERMES_MODEL=<model>',
        '  - SHANNON_EXECUTOR=claude                                (use Claude instead)',
        '',
        'See HERMES_EXECUTOR.md for the full runtime requirements.',
      ].join('\n'),
    };
  }

  // Provider-specific credential heuristics. We accept the run as long as *some*
  // provider credential is present in env; the actual API call (made by the
  // wrapper inside the worker) will surface a concrete auth error if it's the
  // wrong key. Operators can short-circuit this by using mock mode.
  const hasProviderCred =
    !!env.OPENROUTER_API_KEY ||
    !!env.OPENROUTER_API ||
    !!env.OPENAI_API_KEY ||
    !!env.ANTHROPIC_API_KEY ||
    !!env.CLAUDE_CODE_OAUTH_TOKEN ||
    provider === 'custom' ||
    provider === 'mock' ||
    provider === 'ollama' ||
    provider === 'lmstudio' ||
    !!env.SHANNON_HERMES_BASE_URL ||
    !!env.OPENAI_BASE_URL;

  if (!hasProviderCred) {
    return {
      valid: false,
      mode: 'hermes-real',
      error: [
        `Hermes executor is selected with provider="${provider}" and model="${model}", but no provider credential was found in env.`,
        '',
        'Set one of:',
        '  - OPENROUTER_API_KEY=...     (for SHANNON_HERMES_PROVIDER=openrouter)',
        '  - OPENAI_API_KEY=...         (for OpenAI / OpenAI-compatible providers)',
        '  - ANTHROPIC_API_KEY=...      (for SHANNON_HERMES_PROVIDER=anthropic)',
        '',
        'Or use a local server with SHANNON_HERMES_PROVIDER=custom and SHANNON_HERMES_BASE_URL=http://....',
        'Or set SHANNON_HERMES_MOCK_RESULT="..." for mock mode.',
      ].join('\n'),
    };
  }

  return { valid: true, mode: 'hermes-real' };
}

/** Check if a custom Anthropic-compatible base URL is configured. */
function isCustomBaseUrlConfigured(): boolean {
  return !!(process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Detect which providers are configured via environment variables. */
function detectProviders(): string[] {
  const providers: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) providers.push('Anthropic API key');
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) providers.push('Anthropic OAuth');
  if (isCustomBaseUrlConfigured()) providers.push('Custom Base URL');
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') providers.push('AWS Bedrock');
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') providers.push('Google Vertex');
  return providers;
}

/**
 * Validate that exactly one authentication method is configured.
 *
 * In this fork, the default executor is Hermes. Hermes runs use a different
 * credential model than Claude (provider/model env + optional mock mode);
 * this function dispatches based on the resolved executor.
 *
 * Operators force the legacy Claude path with `SHANNON_EXECUTOR=claude`.
 */
export function validateCredentials(): CredentialValidation {
  const executor = resolveExecutor();
  if (executor === null) {
    return {
      valid: false,
      mode: 'api-key',
      error: `SHANNON_EXECUTOR="${process.env.SHANNON_EXECUTOR}" is not a recognized executor. Expected one of: hermes, claude.`,
    };
  }
  if (executor === 'hermes') {
    return validateHermesCredentials();
  }

  // Claude path — unchanged behavior.
  // Reject multiple providers
  const providers = detectProviders();
  if (providers.length > 1) {
    return {
      valid: false,
      mode: 'api-key',
      error: `Multiple providers detected: ${providers.join(', ')}. Only one provider can be active at a time.`,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return { valid: true, mode: 'api-key' };
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { valid: true, mode: 'oauth' };
  }
  if (isCustomBaseUrlConfigured()) {
    return { valid: true, mode: 'custom-base-url' };
  }
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    const missing: string[] = [];
    if (!process.env.AWS_REGION) missing.push('AWS_REGION');
    if (!process.env.AWS_BEARER_TOKEN_BEDROCK) missing.push('AWS_BEARER_TOKEN_BEDROCK');
    if (!process.env.ANTHROPIC_SMALL_MODEL) missing.push('ANTHROPIC_SMALL_MODEL');
    if (!process.env.ANTHROPIC_MEDIUM_MODEL) missing.push('ANTHROPIC_MEDIUM_MODEL');
    if (!process.env.ANTHROPIC_LARGE_MODEL) missing.push('ANTHROPIC_LARGE_MODEL');
    if (missing.length > 0) {
      return {
        valid: false,
        mode: 'bedrock',
        error: `Bedrock mode requires: ${missing.join(', ')}`,
      };
    }
    return { valid: true, mode: 'bedrock' };
  }
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') {
    const missing: string[] = [];
    if (!process.env.CLOUD_ML_REGION) missing.push('CLOUD_ML_REGION');
    if (!process.env.ANTHROPIC_VERTEX_PROJECT_ID) missing.push('ANTHROPIC_VERTEX_PROJECT_ID');
    if (!process.env.ANTHROPIC_SMALL_MODEL) missing.push('ANTHROPIC_SMALL_MODEL');
    if (!process.env.ANTHROPIC_MEDIUM_MODEL) missing.push('ANTHROPIC_MEDIUM_MODEL');
    if (!process.env.ANTHROPIC_LARGE_MODEL) missing.push('ANTHROPIC_LARGE_MODEL');
    if (missing.length > 0) {
      return {
        valid: false,
        mode: 'vertex',
        error: `Vertex AI mode requires: ${missing.join(', ')}`,
      };
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return {
        valid: false,
        mode: 'vertex',
        error: 'Vertex AI mode requires GOOGLE_APPLICATION_CREDENTIALS',
      };
    }
    return { valid: true, mode: 'vertex' };
  }

  const hint =
    getMode() === 'local'
      ? `No credentials found. Set ANTHROPIC_API_KEY in .env (or export it), or use SHANNON_EXECUTOR=hermes with the Hermes runtime envs.`
      : `Authentication not configured. Export variables, run 'npx @keygraph/shannon setup', or use SHANNON_EXECUTOR=hermes.`;
  return {
    valid: false,
    mode: 'api-key',
    error: hint,
  };
}

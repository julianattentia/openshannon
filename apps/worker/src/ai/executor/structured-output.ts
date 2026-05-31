// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Structured-output compatibility helper.
 *
 * Used by `agent-execution.ts` when the selected executor does not natively
 * support schema-constrained generation (today: Hermes). Provides:
 *
 *   1. `buildJsonOutputInstruction(schema)` — a prompt fragment to append
 *      *only* to a Hermes structured-output run. Never injected globally.
 *   2. `extractStructuredOutput(text, schema)` — robust parse-then-validate
 *      using AJV against the same draft-07 JSON Schema already shipped to
 *      Claude's SDK. No `eval`, no shell, no third-party JSON5.
 *
 * Claude's native structured-output path does not call into this module.
 */

import { createRequire } from 'node:module';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';

const require = createRequire(import.meta.url);
const addFormats: FormatsPlugin = require('ajv-formats');

// Same configuration as `config-parser.ts` so error shapes are consistent.
const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
addFormats(ajv);

// Compile once per (schema-identity) — `outputFormat` objects are cached at
// module load in `queue-schemas.ts`, so a WeakMap keyed on the schema object
// avoids re-compiling on every agent invocation.
const validatorCache = new WeakMap<object, ValidateFunction>();

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const compiled = ajv.compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

export type StructuredOutputErrorType = 'structured_output_parse_error' | 'structured_output_validation_error';

export interface ExtractSuccess {
  ok: true;
  value: unknown;
}

export interface ExtractFailure {
  ok: false;
  errorType: StructuredOutputErrorType;
  message: string;
  /** Truncated copy of the model output, safe for logs. */
  rawSnippet: string;
}

export type ExtractResult = ExtractSuccess | ExtractFailure;

const RAW_SNIPPET_MAX = 1000;

/**
 * Build the JSON-output instruction appended to a Hermes prompt.
 *
 * Caller is responsible for appending this to the *local* prompt copy only —
 * never mutate the on-disk prompt template.
 */
export function buildJsonOutputInstruction(schema: Record<string, unknown>): string {
  const serialized = JSON.stringify(schema, null, 2);
  return [
    '',
    '--- STRUCTURED OUTPUT REQUIREMENT ---',
    'You MUST return your final answer as exactly one valid JSON object.',
    'Do not wrap the JSON in markdown.',
    'Do not include a fenced code block.',
    'Do not include prose before or after the JSON.',
    'Do not include comments.',
    'Do not include trailing commas.',
    'Include every required field. Use null only where the schema allows.',
    'Do not invent fields outside the schema.',
    '',
    'The JSON must satisfy this JSON Schema (draft-07):',
    serialized,
  ].join('\n');
}

/**
 * Parse + validate Hermes final text into a structured value.
 *
 * Strategy (first success wins):
 *   1. Try `JSON.parse(text.trim())` and validate.
 *   2. Try every ```` ```json ... ``` ```` fenced block — preferring the last
 *      one if multiple are present. Validate each in order.
 *   3. Try every balanced `{...}` slice extracted by brace-counting
 *      (string-aware). Validate each in order.
 *
 * Arrays are accepted only when the schema explicitly says `type: 'array'`.
 * Empty input is rejected. Multiple equally-valid candidates resolved by
 * "last wins" — fenced blocks are typically the final canonical answer.
 */
export function extractStructuredOutput(
  text: string | null | undefined,
  schema: Record<string, unknown>,
): ExtractResult {
  const raw = (text ?? '').trim();
  if (raw === '') {
    return parseFailure('Hermes returned empty output', raw);
  }

  const schemaAllowsArray = schemaTopLevelType(schema) === 'array';
  const validator = getValidator(schema);

  // 1. Whole-output JSON.
  const direct = tryParse(raw);
  if (direct.ok) {
    const verdict = acceptCandidate(direct.value, schema, validator, schemaAllowsArray);
    if (verdict.kind === 'ok') return { ok: true, value: verdict.value };
    if (verdict.kind === 'invalid') return validationFailure(verdict.message, raw);
    // shape rejection → fall through and try other strategies
  }

  // 2. Fenced blocks (```json … ```). Prefer the LAST one.
  const fenced = extractAllFencedJson(raw);
  for (let i = fenced.length - 1; i >= 0; i--) {
    const candidate = fenced[i];
    if (candidate === undefined) continue;
    const parsed = tryParse(candidate);
    if (!parsed.ok) continue;
    const verdict = acceptCandidate(parsed.value, schema, validator, schemaAllowsArray);
    if (verdict.kind === 'ok') return { ok: true, value: verdict.value };
    if (verdict.kind === 'invalid') {
      // A fenced block parsed but failed schema — that is a definitive validation failure.
      return validationFailure(verdict.message, raw);
    }
  }

  // 3. Balanced objects.
  const objects = extractBalancedJsonObjects(raw);
  if (objects.length === 0 && !direct.ok) {
    return parseFailure('No JSON object found in Hermes output', raw);
  }
  if (objects.length > 1) {
    // Multiple ambiguous objects without a clear fenced winner — reject.
    return parseFailure(
      `Hermes output contained ${objects.length} JSON objects; cannot select unambiguously. Wrap the final answer in a fenced \`\`\`json block.`,
      raw,
    );
  }
  if (objects.length === 1) {
    const obj = objects[0];
    if (obj !== undefined) {
      const parsed = tryParse(obj);
      if (parsed.ok) {
        const verdict = acceptCandidate(parsed.value, schema, validator, schemaAllowsArray);
        if (verdict.kind === 'ok') return { ok: true, value: verdict.value };
        if (verdict.kind === 'invalid') return validationFailure(verdict.message, raw);
      } else {
        return parseFailure(`Hermes JSON object failed to parse: ${parsed.error}`, raw);
      }
    }
  }

  // Final fallback: whole-output parse failed → parse error.
  if (!direct.ok) {
    return parseFailure(`Hermes output is not valid JSON: ${direct.error}`, raw);
  }
  return parseFailure('Hermes output did not contain a JSON value compatible with the schema', raw);
}

interface ParseOk {
  ok: true;
  value: unknown;
}
interface ParseErr {
  ok: false;
  error: string;
}

function tryParse(text: string): ParseOk | ParseErr {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

type AcceptVerdict = { kind: 'ok'; value: unknown } | { kind: 'invalid'; message: string } | { kind: 'shape-rejected' };

function acceptCandidate(
  candidate: unknown,
  _schema: Record<string, unknown>,
  validator: ValidateFunction,
  schemaAllowsArray: boolean,
): AcceptVerdict {
  if (Array.isArray(candidate) && !schemaAllowsArray) {
    return { kind: 'shape-rejected' };
  }
  if (candidate === null || typeof candidate !== 'object') {
    // Primitives are never valid for our object schemas.
    return { kind: 'shape-rejected' };
  }
  const valid = validator(candidate);
  if (valid) {
    return { kind: 'ok', value: candidate };
  }
  return { kind: 'invalid', message: summarizeAjvErrors(validator.errors ?? []) };
}

function schemaTopLevelType(schema: Record<string, unknown>): string | undefined {
  const t = schema.type;
  if (typeof t === 'string') return t;
  return undefined;
}

function summarizeAjvErrors(errors: ErrorObject[]): string {
  const top = errors.slice(0, 5).map((e) => {
    const where = e.instancePath || '/';
    return `${where}: ${e.message ?? 'invalid'}`;
  });
  const suffix = errors.length > 5 ? ` (+${errors.length - 5} more)` : '';
  return top.join('; ') + suffix;
}

function parseFailure(message: string, raw: string): ExtractFailure {
  return {
    ok: false,
    errorType: 'structured_output_parse_error',
    message,
    rawSnippet: truncate(raw, RAW_SNIPPET_MAX),
  };
}

function validationFailure(message: string, raw: string): ExtractFailure {
  return {
    ok: false,
    errorType: 'structured_output_validation_error',
    message,
    rawSnippet: truncate(raw, RAW_SNIPPET_MAX),
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

/**
 * Extract the inner JSON text of every ``` ```json ``` ``` (or bare ``` ``` ```)
 * fenced block whose body parses-or-fails-later as JSON. Returns inner text,
 * trimmed.
 */
function extractAllFencedJson(text: string): string[] {
  const out: string[] = [];
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    const inner = match[1];
    if (inner !== undefined) out.push(inner.trim());
  }
  return out;
}

/**
 * Extract every balanced top-level `{...}` object from `text`. String-aware:
 * braces inside strings don't affect the depth counter; escaped sequences are
 * skipped. No regex — explicit scanner.
 */
function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (i < text.length) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\' && inString) {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            out.push(text.slice(start, i + 1));
            i++;
            break;
          }
        }
      }
      i++;
    }
    if (depth !== 0) {
      // Unbalanced from `start` to EOF — bail out, no more objects.
      break;
    }
  }
  return out;
}

// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Phase 4 Hermes JSONL wrapper protocol.
 *
 * The Python wrapper emits one JSON object per line on stdout. The final
 * line is always either `{"type":"result", ...}` (success or model failure)
 * or `{"type":"error", ...}` (wrapper-detected failure). Anything else
 * appearing after a final event is a protocol violation.
 *
 * Field names are snake_case to match the Python side and to match the
 * Phase 3 envelope.
 */

import { z } from 'zod';

const TimestampField = z.string().optional();

export const HermesSessionStartEventSchema = z.object({
  type: z.literal('session_start'),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  timestamp: TimestampField,
});

export const HermesAssistantDeltaEventSchema = z.object({
  type: z.literal('assistant_delta'),
  text: z.string(),
  timestamp: TimestampField,
});

export const HermesAssistantMessageEventSchema = z.object({
  type: z.literal('assistant_message'),
  text: z.string(),
  truncated: z.boolean().optional(),
  timestamp: TimestampField,
});

export const HermesToolUseEventSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().nullable().optional(),
  name: z.string(),
  input: z.unknown().optional(),
  truncated: z.boolean().optional(),
  timestamp: TimestampField,
});

export const HermesToolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  success: z.boolean().nullable().optional(),
  content: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
  timestamp: TimestampField,
});

export const HermesHeartbeatEventSchema = z.object({
  type: z.literal('heartbeat'),
  timestamp: TimestampField,
});

export const HermesResultEventSchema = z.object({
  type: z.literal('result'),
  success: z.boolean(),
  result: z.string().nullable().optional(),
  duration_ms: z.number().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
  turns: z.number().int().nonnegative().nullable().optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  error_type: z.string().nullable().optional(),
  retryable: z.boolean().nullable().optional(),
  timestamp: TimestampField,
});

export const HermesErrorEventSchema = z.object({
  type: z.literal('error'),
  success: z.literal(false).optional(),
  error: z.string(),
  error_type: z.string().nullable().optional(),
  retryable: z.boolean().nullable().optional(),
  duration_ms: z.number().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
  turns: z.number().int().nonnegative().nullable().optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  timestamp: TimestampField,
});

export const HermesEventSchema = z.discriminatedUnion('type', [
  HermesSessionStartEventSchema,
  HermesAssistantDeltaEventSchema,
  HermesAssistantMessageEventSchema,
  HermesToolUseEventSchema,
  HermesToolResultEventSchema,
  HermesHeartbeatEventSchema,
  HermesResultEventSchema,
  HermesErrorEventSchema,
]);

export type HermesEvent = z.infer<typeof HermesEventSchema>;
export type HermesResultEvent = z.infer<typeof HermesResultEventSchema>;
export type HermesErrorEvent = z.infer<typeof HermesErrorEventSchema>;
export type HermesAssistantMessageEvent = z.infer<typeof HermesAssistantMessageEventSchema>;
export type HermesToolUseEvent = z.infer<typeof HermesToolUseEventSchema>;
export type HermesToolResultEvent = z.infer<typeof HermesToolResultEventSchema>;

export function isFinalEvent(event: HermesEvent): event is HermesResultEvent | HermesErrorEvent {
  return event.type === 'result' || event.type === 'error';
}

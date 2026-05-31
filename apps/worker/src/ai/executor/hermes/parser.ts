// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Streaming JSONL parser for the Hermes wrapper protocol.
 *
 * Splits incoming stdout chunks on newlines, validates each line with the
 * `HermesEventSchema` discriminated union, and surfaces protocol errors as
 * structured failures. Final events (`result` / `error`) are remembered so
 * the executor can detect duplicates or a missing final event on EOF.
 */

import { type HermesEvent, HermesEventSchema, isFinalEvent } from './events.js';

export type ProtocolErrorKind = 'malformed_json' | 'invalid_event' | 'duplicate_final_event' | 'event_after_final';

export interface ProtocolError {
  kind: ProtocolErrorKind;
  message: string;
  rawLine: string;
}

export interface ParserOutput {
  events: HermesEvent[];
  protocolError?: ProtocolError;
}

export class HermesJsonlParser {
  private buffer = '';
  private finalEvent: HermesEvent | null = null;

  /**
   * Feed a chunk of stdout. Returns any newly-parsed events and at most one
   * protocol error (the first one encountered in this chunk). After a
   * protocol error fires, the caller is expected to abort.
   */
  feed(chunk: string): ParserOutput {
    this.buffer += chunk;
    const events: HermesEvent[] = [];
    let newlineIdx = this.buffer.indexOf('\n');

    while (newlineIdx !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      newlineIdx = this.buffer.indexOf('\n');

      const trimmed = rawLine.trim();
      if (trimmed === '') continue;

      const protocolError = this.parseLine(trimmed, events);
      if (protocolError) {
        return { events, protocolError };
      }
    }

    return { events };
  }

  /**
   * Flush any trailing partial line (no terminating newline). Wrappers are
   * required to newline-terminate each event, so a non-empty trailing buffer
   * is a soft protocol violation; we still parse it best-effort.
   */
  flush(): ParserOutput {
    const trailing = this.buffer.trim();
    this.buffer = '';
    if (trailing === '') return { events: [] };
    const events: HermesEvent[] = [];
    const protocolError = this.parseLine(trailing, events);
    return protocolError ? { events, protocolError } : { events };
  }

  finalEventSeen(): HermesEvent | null {
    return this.finalEvent;
  }

  private parseLine(rawLine: string, sink: HermesEvent[]): ProtocolError | undefined {
    let json: unknown;
    try {
      json = JSON.parse(rawLine);
    } catch (err) {
      return {
        kind: 'malformed_json',
        message: `Hermes wrapper emitted non-JSON line: ${(err as Error).message}`,
        rawLine,
      };
    }

    const parsed = HermesEventSchema.safeParse(json);
    if (!parsed.success) {
      return {
        kind: 'invalid_event',
        message: `Hermes wrapper emitted invalid event: ${parsed.error.message}`,
        rawLine,
      };
    }

    const event = parsed.data;

    if (this.finalEvent !== null) {
      if (isFinalEvent(event)) {
        return {
          kind: 'duplicate_final_event',
          message: `Hermes wrapper emitted a second final event (${event.type}) after ${this.finalEvent.type}.`,
          rawLine,
        };
      }
      return {
        kind: 'event_after_final',
        message: `Hermes wrapper emitted ${event.type} after final ${this.finalEvent.type}.`,
        rawLine,
      };
    }

    if (isFinalEvent(event)) {
      this.finalEvent = event;
    }

    sink.push(event);
    return undefined;
  }
}

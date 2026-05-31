// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Hermes-only prompt compatibility shim.
 *
 * Shannon's agent prompts ship hard-coded Claude Code tool names
 * (`Bash`, `Read`, `Edit`, `Write`, `Task`, `TodoWrite`, `playwright-cli`).
 * Hermes models see these references and may improvise — which produces
 * worse tool calls and confused planning. This helper appends a short
 * Hermes-side translation block to the *local* prompt copy only.
 *
 * - Never applied to Claude runs.
 * - Never mutates on-disk prompt templates.
 * - Idempotent: a marker line keeps repeat invocations from stacking blocks.
 * - Applied before structured-output instructions so the JSON requirement
 *   stays at the end (last instruction wins for most models).
 */

const SHIM_MARKER = '<!-- shannon:hermes-prompt-shim:v1 -->';

const SHIM_BODY = `${SHIM_MARKER}

--- Hermes execution compatibility ---
The task description below may mention Claude Code tool names. In this Hermes
run, map them as follows when deciding what tool to call:
- "Bash" / shell / command line             → use the \`terminal\` toolset (the \`terminal\` and \`process\` tools).
- "Read" / "LS" / "Glob" / "Grep"           → use the \`file\` toolset (\`read_file\`, \`search_files\`).
- "Write" / "Edit" / "MultiEdit"            → use the \`file\` toolset (\`write_file\`, \`patch\`).
- "Task" / "subagent" / "delegate"          → do NOT spawn subagents. Perform the work directly and sequentially.
- "TodoWrite"                               → keep your own internal plan; do not call a TodoWrite tool.
- "playwright-cli" / browser automation     → use the \`browser\` toolset (\`browser_navigate\`, \`browser_click\`, \`browser_snapshot\`, \`browser_type\`, …).
- "Claude Code" / "Claude SDK"              → ignore the brand name; use whatever Hermes tool fits.

Safety constraints from the original task remain in force. In addition:
- Do not read \`.env\` files or any other file that may contain secrets.
- Do not access external targets unless the original task explicitly authorizes it.
- If a tool you want to use is not available, say so plainly instead of guessing.
`;

export interface ApplyHermesPromptShimOptions {
  /** When true, downstream callers append a structured-output instruction after this shim. Documented for clarity. */
  needsStructuredOutput?: boolean;
  /** Hint to the model that a browser toolset run is likely. Currently informational; reserved for future tweaks. */
  browserExpected?: boolean;
}

/**
 * Append the Hermes compatibility block to a prompt, unless it's already there.
 * Returns the original prompt unchanged if the marker is already present.
 */
export function applyHermesPromptShim(prompt: string, _options: ApplyHermesPromptShimOptions = {}): string {
  if (prompt.includes(SHIM_MARKER)) {
    return prompt;
  }
  return `${prompt}\n\n${SHIM_BODY}`;
}

/** Test-only export so unit smoke can match the marker without re-declaring it. */
export const HERMES_PROMPT_SHIM_MARKER = SHIM_MARKER;

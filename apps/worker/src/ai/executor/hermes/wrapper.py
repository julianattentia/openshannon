#!/usr/bin/env python3
# Copyright (C) 2025 Keygraph, Inc.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License version 3
# as published by the Free Software Foundation.

"""Phase 4 Hermes sidecar with JSONL event streaming.

Emits newline-delimited JSON events to stdout. The final event is always
exactly one of ``{"type": "result", ...}`` or ``{"type": "error", ...}``.
Diagnostic output goes to stderr.

Three modes:

* ``--mock-jsonl-transcript PATH`` — replay an existing JSONL file
  verbatim. Used by Shannon tests; no Hermes required.
* ``--mock-result TEXT`` — emit a minimal session_start + result envelope
  for the simplest tests.
* default — instantiate ``AIAgent`` and stream real callbacks. Requires
  Hermes installed and provider credentials.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import threading
import time
import traceback
from typing import Any

# Truncation limits — match the limits documented in Phase 4 design.
ASSISTANT_MESSAGE_MAX = 20_000
TOOL_INPUT_MAX = 20_000
TOOL_RESULT_MAX = 20_000

# stdout lock so callback threads + heartbeat thread don't interleave.
_STDOUT_LOCK = threading.Lock()

# Preserve the original stdout for protocol output. Hermes's own logging
# / retry messages go to stdout via `print(...)` (e.g. `⚠️ API call failed
# …`), which would corrupt our JSONL stream. Inside `_run_hermes` we
# replace sys.stdout with stderr; _PROTOCOL_OUT keeps the real channel.
_PROTOCOL_OUT = sys.stdout


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _emit(payload: dict[str, Any]) -> None:
    """Write one JSON object as a single line to the protocol stdout. Thread-safe."""
    line = json.dumps(payload, ensure_ascii=False, default=_json_default)
    with _STDOUT_LOCK:
        _PROTOCOL_OUT.write(line)
        _PROTOCOL_OUT.write("\n")
        _PROTOCOL_OUT.flush()


def _json_default(value: Any) -> Any:
    """Fallback for objects ``json.dumps`` cannot serialize natively."""
    try:
        return repr(value)
    except Exception:
        return str(type(value))


def _stderr(msg: str) -> None:
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()


def _install_nous_access_token_runtime_patch() -> None:
    """Prefer Nous OAuth invoke JWTs over legacy agent keys in Hermes.

    Hermes 0.15.1 can refresh Nous OAuth successfully, persist the rotated
    token, then return/use a legacy ``agent_key`` that the Nous inference API
    rejects with 401. Shannon runs are long-lived enough to hit that expiry
    boundary often. The refreshed OAuth access token is itself an
    inference-scoped JWT and works as the OpenAI-compatible bearer token, so
    force Hermes' runtime credential resolver to return it when present.
    """
    if os.environ.get("SHANNON_HERMES_NOUS_ACCESS_TOKEN_PATCH", "1").lower() in {"0", "false", "no"}:
        return

    try:
        import hermes_cli.auth as auth_mod  # type: ignore[import-not-found]
    except Exception as exc:
        _stderr(f"Shannon Nous auth patch unavailable: {type(exc).__name__}: {exc}")
        return

    original = getattr(auth_mod, "resolve_nous_runtime_credentials", None)
    if not callable(original) or getattr(original, "_shannon_access_token_patch", False):
        return

    def patched_resolve_nous_runtime_credentials(*args: Any, **kwargs: Any) -> dict[str, Any]:
        creds = original(*args, **kwargs)
        if not isinstance(creds, dict):
            return creds
        try:
            state = auth_mod.get_provider_auth_state("nous") or {}
        except Exception:
            state = {}
        access_token = state.get("access_token")
        if isinstance(access_token, str) and access_token.strip():
            patched = dict(creds)
            patched["api_key"] = access_token.strip()
            patched["source"] = "oauth_access_token"
            patched["auth_path"] = "oauth_access_token"
            patched["expires_at"] = state.get("expires_at") or patched.get("expires_at")
            return patched
        return creds

    patched_resolve_nous_runtime_credentials._shannon_access_token_patch = True  # type: ignore[attr-defined]
    auth_mod.resolve_nous_runtime_credentials = patched_resolve_nous_runtime_credentials

    try:
        import hermes_cli.runtime_provider as runtime_provider_mod  # type: ignore[import-not-found]

        if hasattr(runtime_provider_mod, "resolve_nous_runtime_credentials"):
            runtime_provider_mod.resolve_nous_runtime_credentials = patched_resolve_nous_runtime_credentials
    except Exception:
        pass

    _stderr("Shannon Nous auth patch active: preferring refreshed OAuth access token for runtime API key")


def _truncate(value: str, limit: int) -> tuple[str, bool]:
    if len(value) <= limit:
        return value, False
    return value[:limit] + "\n…[truncated]", True


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=_json_default)
    except Exception:
        return repr(value)


def _emit_assistant_message(text: str) -> None:
    truncated_text, truncated = _truncate(text, ASSISTANT_MESSAGE_MAX)
    payload = {
        "type": "assistant_message",
        "text": truncated_text,
        "timestamp": _now_iso(),
    }
    if truncated:
        payload["truncated"] = True
    _emit(payload)


def _emit_tool_use(name: str, tool_input: Any, tool_id: str | None) -> None:
    serialized = _coerce_text(tool_input)
    truncated_input, truncated = _truncate(serialized, TOOL_INPUT_MAX)
    payload: dict[str, Any] = {
        "type": "tool_use",
        "id": tool_id,
        "name": name,
        "input": truncated_input,
        "timestamp": _now_iso(),
    }
    if truncated:
        payload["truncated"] = True
    _emit(payload)


def _emit_tool_result(name: str | None, content: Any, tool_id: str | None, success: bool | None) -> None:
    serialized = _coerce_text(content)
    truncated_content, truncated = _truncate(serialized, TOOL_RESULT_MAX)
    payload: dict[str, Any] = {
        "type": "tool_result",
        "id": tool_id,
        "name": name,
        "success": success,
        "content": truncated_content,
        "timestamp": _now_iso(),
    }
    if truncated:
        payload["truncated"] = True
    _emit(payload)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="shannon-hermes-wrapper")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--model", default=None)
    parser.add_argument("--provider", default=None)
    parser.add_argument("--base-url", default=None, help="Override OpenAI-compatible base URL (e.g. local llama.cpp / vLLM).")
    parser.add_argument("--toolsets", default=None)
    parser.add_argument("--max-iterations", type=int, default=None)
    parser.add_argument(
        "--heartbeat-interval-ms",
        type=int,
        default=20_000,
        help="Heartbeat emit interval. 0 disables.",
    )
    parser.add_argument("--mock-result", default=None, help="Phase 3-compatible mock mode.")
    parser.add_argument(
        "--mock-jsonl-transcript",
        default=None,
        help="Path to a JSONL transcript; replayed verbatim to stdout.",
    )
    parser.add_argument(
        "--allow-context-files",
        action="store_true",
        help=(
            "Allow Hermes to load AGENTS.md / .cursorrules from the target CWD. "
            "OFF by default because Shannon runs against untrusted target repos. "
            "Enable only when the target is explicitly trusted."
        ),
    )
    return parser.parse_args(argv)


def _read_prompt(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


# ---------------------------------------------------------------------------
# Mock modes
# ---------------------------------------------------------------------------


def _run_transcript_replay(args: argparse.Namespace) -> int:
    """Stream a JSONL transcript verbatim. Lines that aren't valid JSON are skipped with a stderr note."""
    path = args.mock_jsonl_transcript
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line_no, raw in enumerate(handle, start=1):
                line = raw.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as exc:
                    _stderr(f"wrapper: transcript line {line_no} is not JSON: {exc}; skipping")
                    continue
                _emit(payload)
        return 0
    except OSError as exc:
        _emit(_error_envelope(args, f"failed to read transcript: {exc}", "wrapper_internal_error", False))
        return 2


def _run_mock_result(args: argparse.Namespace) -> int:
    _emit(
        {
            "type": "session_start",
            "model": args.model or "mock",
            "provider": args.provider or "mock",
            "cwd": args.cwd,
            "timestamp": _now_iso(),
        }
    )
    _emit(
        {
            "type": "result",
            "success": True,
            "result": args.mock_result,
            "duration_ms": 0,
            "cost": 0,
            "turns": 0,
            "model": args.model or "mock",
            "provider": args.provider or "mock",
            "error": None,
            "timestamp": _now_iso(),
        }
    )
    return 0


# ---------------------------------------------------------------------------
# Real Hermes execution
# ---------------------------------------------------------------------------


def _error_envelope(args: argparse.Namespace, message: str, error_type: str, retryable: bool) -> dict[str, Any]:
    return {
        "type": "error",
        "error": message,
        "error_type": error_type,
        "retryable": retryable,
        "duration_ms": 0,
        "cost": 0,
        "turns": 0,
        "model": args.model,
        "provider": args.provider,
        "timestamp": _now_iso(),
    }


class _Heartbeat:
    def __init__(self, interval_ms: int) -> None:
        self._interval = max(0.0, interval_ms / 1000.0) if interval_ms > 0 else 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "_Heartbeat":
        if self._interval > 0:
            self._thread = threading.Thread(target=self._loop, name="hermes-heartbeat", daemon=True)
            self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                _emit({"type": "heartbeat", "timestamp": _now_iso()})
            except Exception:  # pragma: no cover
                return


def _run_hermes(args: argparse.Namespace, prompt: str) -> int:
    # Keep our JSONL protocol stream clean: any `print()` from hermes-agent
    # (retry warnings, progress messages, etc.) now goes to stderr while
    # we own the real stdout via _PROTOCOL_OUT / _emit().
    sys.stdout = sys.stderr

    try:
        from run_agent import AIAgent  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover - exercised only with Hermes installed
        _emit(_error_envelope(args, f"Failed to import Hermes AIAgent: {exc}", "hermes_import_failed", False))
        return 0
    _install_nous_access_token_runtime_patch()

    def _on_tool_start(*cb_args: Any, **cb_kwargs: Any) -> None:
        name, tool_input, tool_id = _extract_tool_start(cb_args, cb_kwargs)
        _emit_tool_use(name=name, tool_input=tool_input, tool_id=tool_id)

    def _on_tool_complete(*cb_args: Any, **cb_kwargs: Any) -> None:
        name, content, tool_id, success = _extract_tool_complete(cb_args, cb_kwargs)
        _emit_tool_result(name=name, content=content, tool_id=tool_id, success=success)

    kwargs: dict[str, Any] = {
        "quiet_mode": True,
        "tool_start_callback": _on_tool_start,
        "tool_complete_callback": _on_tool_complete,
    }
    if not args.allow_context_files:
        # Disable target-repo context loading (AGENTS.md / .cursorrules) by default.
        # Anything inside the target repo is untrusted from a pentest perspective.
        # Belt-and-braces: env var (honored by hermes-agent bootstrap) plus the
        # `skip_context_files` constructor kwarg confirmed against hermes-agent
        # 0.14.0's AIAgent signature.
        os.environ.setdefault("HERMES_IGNORE_RULES", "1")
        kwargs.setdefault("skip_context_files", True)
    if args.model:
        kwargs["model"] = args.model
    if args.provider:
        kwargs["provider"] = args.provider
    if args.base_url:
        kwargs["base_url"] = args.base_url
    if args.toolsets:
        kwargs["enabled_toolsets"] = [t.strip() for t in args.toolsets.split(",") if t.strip()]
    if args.max_iterations is not None:
        kwargs["max_iterations"] = args.max_iterations

    _emit(
        {
            "type": "session_start",
            "model": args.model,
            "provider": args.provider,
            "cwd": args.cwd,
            "timestamp": _now_iso(),
        }
    )

    started = time.monotonic()
    with _Heartbeat(args.heartbeat_interval_ms):
        try:
            agent = AIAgent(**kwargs)
            conversation = agent.run_conversation(prompt)
        except Exception as exc:  # pragma: no cover - real-Hermes path
            duration_ms = int((time.monotonic() - started) * 1000)
            payload = _error_envelope(args, f"{type(exc).__name__}: {exc}", "hermes_runtime_error", False)
            payload["duration_ms"] = duration_ms
            _emit(payload)
            return 0

    duration_ms = int((time.monotonic() - started) * 1000)
    error = conversation.get("error") if isinstance(conversation, dict) else None
    completed = bool(conversation.get("completed")) if isinstance(conversation, dict) else False
    final_response = conversation.get("final_response") if isinstance(conversation, dict) else None
    turns = conversation.get("api_calls") if isinstance(conversation, dict) else None
    partial = bool(conversation.get("partial")) if isinstance(conversation, dict) else False

    if isinstance(final_response, str) and final_response:
        _emit_assistant_message(final_response)

    cost = 0.0
    try:
        cost = float(getattr(agent, "session_estimated_cost_usd", 0) or 0)
    except Exception:
        cost = 0.0
    model = getattr(agent, "model", args.model)
    provider = getattr(agent, "provider", args.provider)

    # Classify the wrapper-observed failure shape so Shannon's Phase 5 error map
    # can apply the right retry policy. Hermes signals max-iterations by
    # returning `{"completed": False}` with no `error` string; we need to
    # surface that explicitly as a retryable `max_iterations` rather than
    # leaving it to fallthrough heuristics.
    success = error is None and completed
    explicit_error_type: str | None = None
    explicit_retryable: bool | None = None
    if not success and error is None:
        # Completed-false without an explicit error → iteration budget exhaustion
        # or partial-stream truncation. Both are retryable.
        explicit_error_type = "max_iterations"
        explicit_retryable = True
        error = (
            f"Hermes iteration budget exhausted after {turns} call(s)"
            if not partial
            else f"Hermes returned a partial response after {turns} call(s)"
        )

    payload: dict[str, Any] = {
        "type": "result",
        "success": success,
        "result": final_response if isinstance(final_response, str) else None,
        "duration_ms": duration_ms,
        "cost": cost,
        "turns": turns,
        "model": model,
        "provider": provider,
        "error": error,
        "timestamp": _now_iso(),
    }
    if explicit_error_type is not None:
        payload["error_type"] = explicit_error_type
    if explicit_retryable is not None:
        payload["retryable"] = explicit_retryable

    _emit(payload)
    return 0


def _extract_tool_start(cb_args: tuple[Any, ...], cb_kwargs: dict[str, Any]) -> tuple[str, Any, str | None]:
    """Extract (name, input, id) from a `tool_start_callback` invocation.

    Confirmed Hermes 0.14.0 signature (verified against run_agent.py):
        tool_start_callback(tc.id, name, args)
    so positional args are `(id, name, input)`.
    """
    tool_id = cb_kwargs.get("id") or cb_kwargs.get("tool_id") or (cb_args[0] if len(cb_args) > 0 else None)
    name = cb_kwargs.get("name") or cb_kwargs.get("tool_name") or (cb_args[1] if len(cb_args) > 1 else "unknown")
    tool_input = cb_kwargs.get("args") or cb_kwargs.get("input") or cb_kwargs.get("arguments") or (cb_args[2] if len(cb_args) > 2 else None)
    return str(name), tool_input, (str(tool_id) if tool_id is not None else None)


def _extract_tool_complete(cb_args: tuple[Any, ...], cb_kwargs: dict[str, Any]) -> tuple[str | None, Any, str | None, bool | None]:
    """Extract (name, content, id, success) from a `tool_complete_callback` invocation.

    Confirmed Hermes 0.14.0 signature:
        tool_complete_callback(tool_call.id, function_name, function_args, function_result)
    so positional args are `(id, name, input, result)`.
    """
    tool_id = cb_kwargs.get("id") or cb_kwargs.get("tool_id") or (cb_args[0] if len(cb_args) > 0 else None)
    name = cb_kwargs.get("name") or cb_kwargs.get("tool_name") or (cb_args[1] if len(cb_args) > 1 else None)
    content = cb_kwargs.get("result") or cb_kwargs.get("output") or (cb_args[3] if len(cb_args) > 3 else None)
    success_raw = cb_kwargs.get("success") if "success" in cb_kwargs else None
    success: bool | None = None
    if isinstance(success_raw, bool):
        success = success_raw
    elif isinstance(content, dict):
        is_err = content.get("is_error") if isinstance(content.get("is_error"), bool) else None
        success = (not is_err) if is_err is not None else None
    return (str(name) if name is not None else None, content, (str(tool_id) if tool_id is not None else None), success)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    args = _parse_args(argv)

    if args.mock_jsonl_transcript is not None:
        return _run_transcript_replay(args)

    try:
        prompt = _read_prompt(args.prompt_file)
    except OSError as exc:
        _stderr(f"wrapper: failed to read prompt file: {exc}")
        _emit(_error_envelope(args, f"failed to read prompt file: {exc}", "wrapper_input_error", False))
        return 2

    try:
        os.chdir(args.cwd)
    except OSError as exc:
        _stderr(f"wrapper: failed to chdir to {args.cwd}: {exc}")
        _emit(_error_envelope(args, f"failed to chdir to {args.cwd}: {exc}", "wrapper_input_error", False))
        return 2

    try:
        if args.mock_result is not None:
            return _run_mock_result(args)
        return _run_hermes(args, prompt)
    except Exception as exc:  # pragma: no cover - last-resort guard
        _stderr("wrapper: unexpected exception:\n" + traceback.format_exc())
        _emit(_error_envelope(args, f"wrapper crashed: {type(exc).__name__}: {exc}", "wrapper_internal_error", False))
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

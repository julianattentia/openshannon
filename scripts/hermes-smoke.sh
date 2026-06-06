#!/usr/bin/env bash
# Copyright (C) 2025 Keygraph, Inc.
#
# Hermes pipeline smoke test.
#
# Always runs the offline node:test smoke suite (builds first) — no GPU, no
# Docker, no Temporal. These exercise the Hermes execution plumbing via the
# wrapper's --mock-result mode plus the prompt/config/collector-fallback seams.
#
# Optionally runs a real minimal `--only pre-recon` scan to confirm deliverables
# land end-to-end on the Hermes path — but only when the infra is explicitly
# provided and reachable. Otherwise the real run is skipped cleanly (exit 0).
#
# Enable the real run by setting:
#   SHANNON_HERMES_BASE_URL   reachable OpenAI-compatible endpoint
#   SMOKE_TARGET_URL          target app URL (use an owned/authorized target)
#   SMOKE_REPO                path to the target source repo
# plus the usual Hermes config (SHANNON_HERMES_MODEL / SHANNON_HERMES_PROVIDER)
# and any preflight gates your environment requires.
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env if present (non-fatal).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

echo "== build =="
pnpm run build >/dev/null

echo "== offline node:test smoke suite =="
node --test apps/worker/test/*.test.mjs

# ---------------------------------------------------------------------------
# Optional real run (skipped unless fully configured + reachable).
# ---------------------------------------------------------------------------
BASE_URL="${SHANNON_HERMES_BASE_URL:-}"
TARGET="${SMOKE_TARGET_URL:-}"
REPO="${SMOKE_REPO:-}"

if [ -z "$BASE_URL" ] || [ -z "$TARGET" ] || [ -z "$REPO" ]; then
  echo "== real run skipped: set SHANNON_HERMES_BASE_URL, SMOKE_TARGET_URL, SMOKE_REPO to enable =="
  exit 0
fi

if ! curl -fsS --max-time 5 "${BASE_URL%/}/models" >/dev/null 2>&1; then
  echo "== real run skipped: LLM server unreachable at ${BASE_URL} =="
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "== real run skipped: Docker is not running =="
  exit 0
fi

WS="hermes-smoke-$(date +%s)"
echo "== real pre-recon smoke against ${TARGET} (workspace ${WS}) =="
./shannon start -u "$TARGET" -r "$REPO" --only pre-recon -w "$WS"

DELIV="workspaces/${WS}/deliverables/pre_recon_deliverable.md"
if [ -s "$DELIV" ] && [ "$(wc -c < "$DELIV")" -gt 200 ]; then
  echo "PASS: ${DELIV} produced ($(wc -c < "$DELIV") bytes) on the Hermes path"
else
  echo "FAIL: ${DELIV} missing or suspiciously small"
  exit 1
fi

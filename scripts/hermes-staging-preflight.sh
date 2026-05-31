#!/usr/bin/env bash
# Copyright (C) 2025 Keygraph, Inc.
#
# Hermes staging trial preflight + safe-launch gate.
#
# Purpose:
#   Refuse to launch any Hermes Shannon staging run unless every safety gate
#   is satisfied. Print exactly what's missing if not.
#
# Two run modes:
#
#   Narrow phase (--only <phase>): requires ATTENTIA_STAGING_SINGLE_VULN_ALLOWED=1 (or phase-specific gate)
#     pre-recon: ATTENTIA_STAGING_TRIAL_ALLOWED=1 (always allowed)
#     recon:     ATTENTIA_STAGING_RECON_ALLOWED=1
#     vuln:auth: ATTENTIA_STAGING_SINGLE_VULN_ALLOWED=1
#     vuln:ssrf: ATTENTIA_STAGING_SINGLE_VULN_ALLOWED=1
#     vuln:document-processing: ATTENTIA_STAGING_SINGLE_VULN_ALLOWED=1
#
#   Full vuln suite, no exploit (no --only, with --no-exploit):
#     requires ATTENTIA_STAGING_FULL_VULN_SUITE_ALLOWED=1
#     requires ATTENTIA_STAGING_EXPLOIT_ALLOWED=0  (must be exactly 0, not unset)
#
# Usage:
#   bash scripts/hermes-staging-preflight.sh --only pre-recon
#   ATTENTIA_STAGING_RECON_ALLOWED=1 bash scripts/hermes-staging-preflight.sh --only recon
#   ATTENTIA_STAGING_SINGLE_VULN_ALLOWED=1 bash scripts/hermes-staging-preflight.sh --only vuln:auth
#   ATTENTIA_STAGING_FULL_VULN_SUITE_ALLOWED=1 ATTENTIA_STAGING_EXPLOIT_ALLOWED=0 bash scripts/hermes-staging-preflight.sh --no-exploit
#   # or via env:
#   ATTENTIA_STAGING_ONLY_PHASE=recon ATTENTIA_STAGING_RECON_ALLOWED=1 bash scripts/hermes-staging-preflight.sh
#
# Required env (all must be set):
#   SHANNON_EXECUTOR=hermes                              (or unset → Hermes is default)
#   SHANNON_HERMES_PROVIDER=<provider>
#   SHANNON_HERMES_MODEL=<model>
#   ATTENTIA_STAGING_TRIAL_ALLOWED=1
#   ATTENTIA_STAGING_TARGET=https://staging.attentia.at  (EXACT match)
#   --only <phase>  (arg)  OR  ATTENTIA_STAGING_ONLY_PHASE=<phase>  OR  --no-exploit for full vuln suite
#
# Optional:
#   SHANNON_HERMES_BASE_URL=...
#   HERMES_HOME=/tmp/shannon-hermes
#   SHANNON_WORKER_IMAGE=shannon-worker  (defaults to shannon-worker)
#
# Exit codes:
#   0 — all gates pass; operator may proceed with the printed command
#   1 — refused; refer to printed reason

set -euo pipefail

# Never operate with set -x. Never echo env.
fail() { echo "REFUSED: $*" >&2; exit 1; }

# Parse args.
ONLY_PHASE_ARG=""
NO_EXPLOIT_ARG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      shift
      [ $# -gt 0 ] || fail "--only requires a phase name."
      ONLY_PHASE_ARG="$1"
      shift
      ;;
    --only=*)
      ONLY_PHASE_ARG="${1#--only=}"
      shift
      ;;
    --no-exploit)
      NO_EXPLOIT_ARG=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done
ONLY_PHASE="${ONLY_PHASE_ARG:-${ATTENTIA_STAGING_ONLY_PHASE:-}}"

# Gate 1: explicit opt-in
[ "${ATTENTIA_STAGING_TRIAL_ALLOWED:-}" = "1" ] \
  || fail "ATTENTIA_STAGING_TRIAL_ALLOWED is not set to 1. The operator must explicitly opt in to a staging trial."

# Gate 2: exact-match target (no other URLs accepted)
EXPECTED_TARGET="https://staging.attentia.at"
[ "${ATTENTIA_STAGING_TARGET:-}" = "$EXPECTED_TARGET" ] \
  || fail "ATTENTIA_STAGING_TARGET must be exactly '$EXPECTED_TARGET'. Got: '${ATTENTIA_STAGING_TARGET:-<unset>}'."

# Gate 3: reject any production-looking hostname that crept in
case "${ATTENTIA_STAGING_TARGET}" in
  *production*|*prod.*|*www.*|*app.*) fail "Target looks like a production hostname; refusing." ;;
esac

# Gate 4: executor must be Hermes (default in this fork; or explicit)
EXECUTOR="${SHANNON_EXECUTOR:-hermes}"
case "$EXECUTOR" in
  hermes) ;;  # ok
  claude) fail "SHANNON_EXECUTOR=claude. This staging trial is Hermes-only by design. Unset SHANNON_EXECUTOR or set it to hermes." ;;
  *)      fail "SHANNON_EXECUTOR=$EXECUTOR is not a recognized executor." ;;
esac

# Gate 5: provider + model must be set (no mock for real targets)
[ -n "${SHANNON_HERMES_PROVIDER:-}" ] || fail "SHANNON_HERMES_PROVIDER is required for a real staging trial."
[ -n "${SHANNON_HERMES_MODEL:-}" ]    || fail "SHANNON_HERMES_MODEL is required for a real staging trial."

# Gate 6: don't accept SHANNON_HERMES_MOCK_* against a real target
[ -z "${SHANNON_HERMES_MOCK_RESULT:-}" ] \
  || fail "SHANNON_HERMES_MOCK_RESULT is set but target is real staging. Unset it."
[ -z "${SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT:-}" ] \
  || fail "SHANNON_HERMES_MOCK_JSONL_TRANSCRIPT is set but target is real staging. Unset it."

# Gate 7: AGENTS.md/.cursorrules loading must remain off (target = untrusted)
case "${SHANNON_HERMES_ALLOW_CONTEXT_FILES:-0}" in
  ""|"0"|"false"|"False") ;;
  *) fail "SHANNON_HERMES_ALLOW_CONTEXT_FILES is truthy; for a real staging target this MUST stay off (prompt-injection risk)." ;;
esac

# Gate 8: worker image must include the Hermes runtime
WORKER_IMAGE="${SHANNON_WORKER_IMAGE:-shannon-worker}"
if ! docker image inspect "$WORKER_IMAGE" >/dev/null 2>&1; then
  fail "Worker image '$WORKER_IMAGE' does not exist locally. Run: ./shannon build  (with SHANNON_EXECUTOR=hermes for the Hermes runtime)."
fi
if ! docker run --rm --entrypoint=/bin/sh "$WORKER_IMAGE" -lc 'test -x /opt/hermes/bin/python3' >/dev/null 2>&1; then
  fail "Worker image '$WORKER_IMAGE' lacks the Hermes Python runtime (/opt/hermes/bin/python3). Rebuild with: SHANNON_EXECUTOR=hermes ./shannon build  (or docker build --build-arg WITH_HERMES=1 -t $WORKER_IMAGE .)."
fi

# Gate 9: phase isolation.
# Accepted phases: pre-recon (always), recon (requires ATTENTIA_STAGING_RECON_ALLOWED=1),
# vuln:auth / vuln:ssrf (requires ATTENTIA_STAGING_SINGLE_VULN_ALLOWED=1).
# Normalize aliases to match `apps/cli/src/index.ts:normalizeOnlyPhase`.
ONLY_PHASE_LOWER="$(echo "${ONLY_PHASE}" | tr '[:upper:]' '[:lower:]' | tr '_' '-' | tr -d '[:space:]')"
case "$ONLY_PHASE_LOWER" in
  pre-recon|pre-recon-code)
    ONLY_PHASE_NORM="pre-recon"
    ;;
  recon)
    ONLY_PHASE_NORM="recon"
    [ "${ATTENTIA_STAGING_RECON_ALLOWED:-}" = "1" ] \
      || fail "ATTENTIA_STAGING_RECON_ALLOWED is not set to 1. Set it to proceed with --only recon."
    ;;
  vuln:auth|auth|vuln:auth-session|auth-session)
    ONLY_PHASE_NORM="vuln:auth"
    [ "${ATTENTIA_STAGING_SINGLE_VULN_ALLOWED:-}" = "1" ] \
      || fail "ATTENTIA_STAGING_SINGLE_VULN_ALLOWED is not set to 1. Set it to proceed with --only vuln:auth."
    ;;
  vuln:ssrf|ssrf|vuln:ssrf-config|ssrf-config|config-ssrf|vuln:config-ssrf)
    ONLY_PHASE_NORM="vuln:ssrf"
    [ "${ATTENTIA_STAGING_SINGLE_VULN_ALLOWED:-}" = "1" ] \
      || fail "ATTENTIA_STAGING_SINGLE_VULN_ALLOWED is not set to 1. Set it to proceed with --only vuln:ssrf."
    ;;
  vuln:document-processing|vuln:documents|vuln:file-upload|vuln:upload|vuln:phi-artifacts|documents|document-processing|file-upload|upload|phi-artifacts)
    ONLY_PHASE_NORM="vuln:document-processing"
    [ "${ATTENTIA_STAGING_SINGLE_VULN_ALLOWED:-}" = "1" ] \
      || fail "ATTENTIA_STAGING_SINGLE_VULN_ALLOWED is not set to 1. Set it to proceed with --only vuln:document-processing."
    ;;
  vuln|vuln:all|exploit|report)
    fail "Broad selector '${ONLY_PHASE}' is not allowed for staging. Use a specific phase: vuln:auth, vuln:ssrf, or vuln:document-processing. For the full vuln suite, use --no-exploit without --only."
    ;;
  "")
    # No --only set — allow full vuln suite only with explicit gates and --no-exploit.
    if [ "$NO_EXPLOIT_ARG" != "1" ]; then
      fail "Phase isolation required. Either pass --only <phase> to run a single phase, or pass --no-exploit (with ATTENTIA_STAGING_FULL_VULN_SUITE_ALLOWED=1 and ATTENTIA_STAGING_EXPLOIT_ALLOWED=0) for the full vuln suite."
    fi
    [ "${ATTENTIA_STAGING_FULL_VULN_SUITE_ALLOWED:-}" = "1" ] \
      || fail "ATTENTIA_STAGING_FULL_VULN_SUITE_ALLOWED is not set to 1. Set it to proceed with the full vuln-suite run."
    [ "${ATTENTIA_STAGING_EXPLOIT_ALLOWED:-}" = "0" ] \
      || fail "ATTENTIA_STAGING_EXPLOIT_ALLOWED must be exactly '0' for the full vuln suite run (exploit agents are not allowed against staging)."
    ONLY_PHASE_NORM="full-vuln-suite"
    ;;
  *)
    fail "Unsupported --only value: '${ONLY_PHASE}'. Supported: pre-recon, recon, vuln:auth (aliases: auth, vuln:auth-session, auth-session), vuln:ssrf (aliases: ssrf, vuln:ssrf-config, ssrf-config, config-ssrf), vuln:document-processing (aliases: documents, document-processing, file-upload, upload, phi-artifacts). For full suite: use --no-exploit without --only."
    ;;
esac

# Derive suggested workspace name for the printed command.
case "$ONLY_PHASE_NORM" in
  pre-recon)  SUGGESTED_WORKSPACE="hermes-staging-pre-recon-001" ;;
  recon)      SUGGESTED_WORKSPACE="hermes-staging-pre-recon-003" ;;
  vuln:auth)  SUGGESTED_WORKSPACE="hermes-staging-pre-recon-003" ;;
  vuln:ssrf)  SUGGESTED_WORKSPACE="hermes-staging-pre-recon-003" ;;
  vuln:document-processing) SUGGESTED_WORKSPACE="hermes-staging-pre-recon-003" ;;
  full-vuln-suite) SUGGESTED_WORKSPACE="hermes-staging-full-vuln-001" ;;
  *)          SUGGESTED_WORKSPACE="hermes-staging-workspace" ;;
esac

echo "All staging-trial gates passed."
echo "Target: $ATTENTIA_STAGING_TARGET"
echo "Executor: $EXECUTOR"
echo "Image: $WORKER_IMAGE (Hermes runtime present)"
if [ "$ONLY_PHASE_NORM" = "full-vuln-suite" ]; then
  echo "Run scope: full vuln suite (--no-exploit, exploit agents blocked)"
else
  echo "Run scope: --only $ONLY_PHASE_NORM"
fi
echo
echo "Operator: review and then run this command yourself. This script will NOT launch it."
echo
if [ "$ONLY_PHASE_NORM" = "full-vuln-suite" ]; then
  echo "  ./shannon start \\"
  echo "    -u $ATTENTIA_STAGING_TARGET \\"
  echo "    -r <local repo path for staging.attentia.at> \\"
  echo "    -w $SUGGESTED_WORKSPACE \\"
  echo "    --no-exploit"
else
  echo "  ./shannon start \\"
  echo "    -u $ATTENTIA_STAGING_TARGET \\"
  echo "    -r <local repo path for staging.attentia.at> \\"
  echo "    -w $SUGGESTED_WORKSPACE \\"
  echo "    --only $ONLY_PHASE_NORM"
fi
echo
echo "After it completes, inspect workspaces/$SUGGESTED_WORKSPACE/ before any further phase."

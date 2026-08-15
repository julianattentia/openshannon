# openshannon — Hermes fork of Shannon

Fork of [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon). All upstream functionality is preserved; this fork adds a second executor backend (Hermes) alongside Claude, plus two new pipeline flags.

---

## What changed from upstream

### 1. Hermes executor (`SHANNON_EXECUTOR=hermes`, the new default)

Shannon's agent loop was originally hardwired to the Anthropic Claude SDK. This fork extracts an executor abstraction and adds a Hermes backend that drives any OpenAI-compatible local or remote model via the Hermes Python agent framework.

Hermes is now the **default executor**. Set `SHANNON_EXECUTOR=claude` to fall back to the upstream Claude SDK behavior.

**New env vars (all `SHANNON_HERMES_*`):**

| Var | Required | Description |
|---|---|---|
| `SHANNON_HERMES_PROVIDER` | yes | Provider name passed to Hermes (e.g. `custom`, `openai`, `openrouter`) |
| `SHANNON_HERMES_MODEL` | yes | Model name/path (e.g. `Qwen3.6-27B-Q4_K_M.gguf`) |
| `SHANNON_HERMES_BASE_URL` | for custom | OpenAI-compatible base URL (e.g. `http://192.168.0.10:8000/v1`) |
| `SHANNON_HERMES_MAX_ITERATIONS` | no | Cap agent turns (default: unlimited) |
| `SHANNON_HERMES_TIMEOUT_MS` | no | Per-turn timeout |
| `SHANNON_HERMES_ALLOW_CONTEXT_FILES` | no | Load AGENTS.md/.cursorrules into context (default: off — prompt-injection risk on untrusted targets) |

The Hermes Python runtime is baked into the Docker image via `WITH_HERMES=1` build arg (already set in the local `Dockerfile`).

### 2. `--only <phase>` — single-phase runs

Run exactly one pipeline phase and stop. Useful for staged assessments or iterating on a specific vuln class without re-running recon.

```
./shannon start -u <url> -r <repo> --only pre-recon
./shannon start -u <url> -r <repo> --only recon
./shannon start -u <url> -r <repo> --only vuln:auth
./shannon start -u <url> -r <repo> --only vuln:ssrf
./shannon start -u <url> -r <repo> --only vuln:document-processing
```

Aliases: `auth` → `vuln:auth`, `ssrf` → `vuln:ssrf`, `documents` / `document-processing` / `upload` / `phi-artifacts` → `vuln:document-processing`.

### 3. `--no-exploit` — full vuln suite, no exploit agents

Run all five vuln agents (injection, xss, auth, authz, ssrf) but block all exploit agents from firing, even if the vuln queues are non-empty. The report phase still runs and renders findings from the analysis deliverables.

```
./shannon start -u <url> -r <repo> --no-exploit
```

### 4. `max_concurrent_pipelines` config option

Limits how many vuln agents run in parallel. Default is 5 (upstream behavior). Set to `"1"` in a YAML config when running against a local model that can't handle concurrent inference:

```yaml
# configs/sequential.yaml
exploit: "false"

pipeline:
  max_concurrent_pipelines: "1"
```

---

## Running a new Hermes scan

**Prerequisites:** Docker running, local model server reachable (or any OpenAI-compatible endpoint).

**1. Build the image** (only needed once, or after code changes):

```bash
./shannon build
```

**2. Create a config** (minimum viable — satisfies schema, sets sequential mode):

```yaml
# apps/worker/configs/my-config.yaml
exploit: "false"

pipeline:
  max_concurrent_pipelines: "1"   # set to "5" if your model server handles concurrency
```

**3. Launch:**

```bash
SHANNON_EXECUTOR=hermes \
SHANNON_HERMES_PROVIDER=custom \
SHANNON_HERMES_MODEL=<your-model-name> \
SHANNON_HERMES_BASE_URL=http://<host>:<port>/v1 \
./shannon start \
  -u https://target.example.com \
  -r /path/to/target/repo \
  -w my-workspace-001 \
  -c apps/worker/configs/my-config.yaml \
  --no-exploit
```

**4. Monitor:**

```bash
./shannon logs my-workspace-001
# or Temporal UI: http://localhost:8233
```

**5. Resume after interruption** — rerun the exact same command. Completed agents are skipped automatically.

**6. Results** land in `workspaces/my-workspace-001/deliverables/`.

---

## Staging preflight gate

For runs against a live staging environment, `scripts/hermes-staging-preflight.sh` enforces safety gates (explicit opt-in env vars, exact target URL match, no production hostnames, no mock flags against real targets). Run it and review the printed command before launching.

```bash
ATTENTIA_STAGING_TRIAL_ALLOWED=1 \
ATTENTIA_STAGING_TARGET=https://staging.example.com \
ATTENTIA_STAGING_FULL_VULN_SUITE_ALLOWED=1 \
ATTENTIA_STAGING_EXPLOIT_ALLOWED=0 \
SHANNON_HERMES_PROVIDER=custom \
SHANNON_HERMES_MODEL=<model> \
SHANNON_HERMES_BASE_URL=http://<host>/v1 \
bash scripts/hermes-staging-preflight.sh --no-exploit
```

---

For everything else (workspace management, config schema, auth setup, MFA/TOTP, rules of engagement) see the [upstream README](https://github.com/KeygraphHQ/shannon).

## Bounded local runner

This branch adds `runner/run-once.mjs` for exactly two owned loopback fixtures: `/home/attentia/openshannon/test-apps/crapi` and `/home/attentia/openshannon/test-apps/vulnerable`. Unset, remote, public, production-like, Supabase, `file://`, and other paths are rejected before model, Docker, or Shannon work starts.

Run one bounded phase with the local Qwen model and shared Temporal:

```bash
node runner/run-once.mjs --target /home/attentia/openshannon/test-apps/crapi --phase pre-recon --timeout-seconds 600
```

The runner starts and tears down the selected fixture and the worker it started, writes a count-only summary under `reports/<UTC-date>-<app>/`, and appends `reports/run-ledger.jsonl`. Raw report bodies and exploit material remain in ignored per-workspace deliverables. The auth profile is staged in one workspace with `pre-recon`, `recon`, then `vuln:auth`; the final phase always passes `--no-exploit`. Use `--dry-run` to print the exact command without starting anything.

`local-runs/hermes-cron.disabled` contains the sparse nightly scheduled profile. Every line is commented out intentionally; this branch never starts an unattended loop. See `DECISIONS.md` and `BLOCKERS.md` for observed runs and gaps. PR compare URL:

`https://github.com/julianattentia/openshannon/compare/main...bot/shannon-runner/2026-08-15-bounded-local-runs?expand=1`

Rollback is a branch/PR revert; do not run `./shannon stop --clean` because Temporal is shared infrastructure.

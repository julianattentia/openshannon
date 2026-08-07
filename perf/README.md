# perf/ — deterministic functional/performance harness for Shannon

Boots a web-app target, runs Shannon against it in full vuln-suite mode, and
deterministically asserts that each planted vulnerability class was actually
found in the deliverables.

```
┌─────────────────┐   boot    ┌────────────────────┐   scan   ┌─────────────────┐   assert   ┌────────────┐
│ test-apps/…     │──────────▶│ ./shannon start    │─────────▶│ deliverables    │──────────▶│ PASS/FAIL  │
│ (vulnerable app)│ spawn     │ --no-exploit -o …   │          │ (copied via -o) │           │ per class  │
└─────────────────┘  health   └────────────────────┘          └─────────────────┘           └────────────┘
```

## Usage

```bash
# Run the full suite against the purpose-built fixture (Docker + LLM creds required)
node perf/run.mjs --target vulnerable

# Single class, faster iteration
node perf/run.mjs --target vulnerable --only vuln:ssrf

# Prove the fixture itself is sound without running a scan (no DDK/creds needed)
node perf/run.mjs --target vulnerable --dry-run

# Unit-test the assertion logic (no app, no scan)
node --test perf/test/
```

## Targets (registry: `perf/targets/*.mjs`)

| target | kind | status |
|--------|------|--------|
| `vulnerable` | hermetic Node app, zero deps | **implemented** |
| `crapi` | docker-compose (OWASP crAPI, port 8888) | **implemented** |
| `juice-shop` | docker-compose | planned — not wired |

Each target defines its `expectations` (per-class indicators) and how to boot.
The runner refuses loudly for targets that are declared but not implemented, so
a broken call can never produce a false PASS.

## Model/provider selection

The scan step routes Shannon's Hermes executor to a specific model:

```bash
# local OpenAI-compatible (llama.cpp / vLLM / LM Studio):
node perf/run.mjs --target vulnerable \
  --provider custom --model Qwen3.6-27B-Q4_K_M.gguf \
  --base-url http://host.docker.internal:8001/v1

# cloud OpenRouter (uses OPENROUTER_API_KEY from ~/.hermes/.../.env):
node perf/run.mjs --target crapi \
  --provider openrouter --model deepseek/deepseek-v4-flash-0731 \
  --base-url https://openrouter.ai/api/v1
```

The runner waits for the workflow to complete (polling for the final
`comprehensive_security_assessment_report.md`, up to `SHANNON_PERF_WAIT_MS`
default 40 min) before asserting, so a hung workflow fails loudly instead of
asserting against an empty/stale output dir.

## The fixture (`test-apps/vulnerable`)

A deliberately-insecure, zero-dependency Node `http` app. Every planted vuln is
deterministic and marked `PLANTED-VULN` in source:

- **SQL injection** — `GET /api/search?s=` string-concatenates into a WHERE clause; `' OR '1'='1` returns all rows.
- **Reflected XSS** — `GET /api/echo?msg=` reflects unescaped; **stored XSS** — `POST /api/item` renders `name` unescaped.
- **Auth bypass** — `GET /api/admin` trusts an unsigned `alg:none` JWT; login leaks user enumeration (`POST /api/login`).
- **IDOR / authz** — `GET /api/profile/:id` returns any user's data with no ownership check.
- **SSRF** — `GET /api/fetch?url=` performs an arbitrary server-side fetch (reaches the internal `/api/internal/secrets`).
- **Control (must NOT be flagged)** — `GET /api/control/secure` is parameterized and authenticated.

The fixture ships its own **self-check** (`npm run selfcheck` in
`test-apps/vulnerable`): it asserts each planted vuln is exploitable and the
control endpoint is protected. The harness refuses to scan if the fixture is
broken. **Only bind the app to `127.0.0.1`; it is intentionally insecure and
must never be exposed to a network.**

## Determinism

- All fixtures seed fixed state; every exploit path returns a stable observable.
- Assertion is tolerant of LLM prose: a class PASSes when its deliverable is
  present, non-empty and matches ≥1 of the class indicators (endpoint + keyword).
- A mention of the control endpoint is surfaced as an informational false-positive
  smoke-out, never a hard failure.

## Live-scan prerequisites

The scan step needs a reachable Docker daemon (Temporal infra + worker image)
and provider credentials. If the environment can't scan, the runner exits 0
with a **SKIP** and prints the exact `./shannon start` command to run on a
suitable machine; re-run the harness there and it asserts the deliverables.
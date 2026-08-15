# Decisions

- 2026-08-15 — Used a Git worktree branch `bot/shannon-runner/2026-08-15-bounded-local-runs` from openShannon `main`. The starting workspace was empty and not a repository; a branch-backed worktree keeps all deliverables isolated from the other agents and from `main`/`staging`.
- 2026-08-15 — Kept the target policy to two exact canonical paths. Matching a URL, IP, symlink, path traversal result, or missing fixture is a hard refusal before any service starts.
- 2026-08-15 — Used `--only pre-recon` as the default hand-run phase because it is the cheapest bounded acceptance phase. Added `--profile scheduled` as the sparse full-vulnerability profile with `--no-exploit`; no scheduler is enabled.
- 2026-08-15 — The host queue is verified at `127.0.0.1:8000`, but the Shannon worker runs in Docker. The worker therefore uses `host.docker.internal:8000`, which is the same queue port through the container boundary; direct `:8001` is never used.
- 2026-08-15 — Set Hermes context-file loading off and capped agent iterations at 25 and per-turn timeout at 600 seconds. The first real crAPI attempt demonstrated that 10 iterations exhausted before artifact creation, so 25 is the smallest observed adjustment that allowed completion while remaining bounded.
- 2026-08-15 — The vulnerable fixture has no nested `.git`, while Shannon preflight requires one. The runner creates temporary Git metadata only in that exact allowlisted fixture, never stages files, and removes the metadata in its teardown callback. This is reversible fixture setup, not a pipeline/source change.
- 2026-08-15 — Delivery contains severity counts, paths, status, and timing only. Raw Shannon reports, model drafts, workflow logs, and exploit payloads remain outside committed delivery.
- 2026-08-15 — Telegram was not used because no configured Telegram delivery adapter or credentials were observed; disk delivery plus branch/PR is the safe fallback.

# Blockers and gaps

- The `qwen38` Docker container reports `unhealthy`, but the observed host checks returned HTTP 200 from `/health` and the exact required model id from `/v1/models`; the successful crAPI pre-recon run confirms usable inference. Keep monitoring that health state before enabling a schedule.
- The first real run failed because `127.0.0.1:8000` inside the worker container is not the host queue. The runner now routes the worker to `host.docker.internal:8000` while retaining the mandated queue port and host preflight; no direct model port was used.
- The scheduled full `--no-exploit` profile was not run end to end in this bounded verification pass. It is present, disabled, and capped at 1800 seconds; a human should review the cadence and resource cost before enabling it.
- `gh auth status` is not authenticated, so no GitHub PR was created through the CLI. SSH push and a ready compare URL are the documented delivery path.
- Telegram is not configured on this host. The runner therefore writes the count-only summary and ledger to disk and does not attempt external delivery.
- The ignored crAPI checkout is supplied outside the tracked openShannon tree. It was used read-only as the allowlisted target; it is not included in this branch.

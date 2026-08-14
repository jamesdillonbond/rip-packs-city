# Daytime monitor — 2026-08-14T00:14Z (~17:14 PT, 08-13)

Read-only sweep. Bash/git shell down again (`/sessions` no-space, useradd exit 12) → this file written to the MOUNT, push unavailable; night pass picks it up locally. Concurrency lock is RELEASED (stale, 08-11). Instance is in an ACTIVE disk-IO saturation window right now (`rpc_ops_snapshot()` itself timed out inside `sentinel_fmv_confidence_rows`), so several checks were run individually/cheaply and heavy per-artifact payload validation was deferred this tick (running 11 heavy payloads onto a saturated instance would add load and produce false timeout "breakage").

Health baseline: security CLEAN (invariants 0 / anon_write 0 / secdef_drift clean — the "1" is the documented one-row-empty-array). Trust breaches 3, ALL known/tracked: `panini_sale_price_capture_dry_days` 16 (interactive A/B owed, mechanism unestablished), `public_board_slow_count` 10 (oscillating saturation collateral, was 3 on 08-13 nightly / 16 on 08-11), `unmapped_resolution_backlog_max` 237 (AllDay permanent-class floor, needs resolver reason-based exclusion). `allday-pack-opens-backfill` shows in `detect_stalled_pipelines()` (633 min silent) but job 55 is firing fine (succeeded 00:06Z, "1 row") — this is the EXPECTED terminal `done:true` state predicted in its own note (reaches spork floor ~2026-08-14), NOT a scheduler stop.

## Candidates

### 1. [medium] Superseded production ERROR deploy — OG-card fix build failed, live via later READY
- **Source:** Vercel `list_deployments` (project `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`). One `state: ERROR` in the last-20 set, commit `fix(og): an edge-cached PNG cannot be 'Loading', and an outage is not an empty b…` (Claude Code). It is surrounded by NEWER `READY` production deploys (positions 2–9 newest-first), so production is healthy and the OG fix is live via a later cumulative READY build.
- **Risk:** low to prod (superseded). This is the documented "a disk-IO saturation spell can FAIL THE WHOLE PRODUCTION BUILD, and an ERRORed deploy is easy to miss because the next push supersedes it and goes READY" class — very likely a saturation-window per-page export timeout, not a content error.
- **Action (night pass / Trevor):** confirm the OG-fix content is actually live on the tip READY, and glance at the ERROR build log to confirm timeout-vs-genuine-failure. No revert needed. Sense-only from here.

### 2. [low] New Sentry issue JAVASCRIPT-NEXTJS-28 — "smoke check could not run: anon has no EXECUTE on destructive SECDEF functions"
- **Source:** Sentry `rip-packs-city`, firstSeen ~2h ago, 1 event, 0 users, unresolved.
- **Risk:** low. This is the honest `couldNotRun` pattern firing during the DB-saturation window — the underlying security posture is CLEAN (`check_secdef_anon_exec_drift()` returns clean this run), so the check couldn't evaluate rather than found a real drift. Almost certainly saturation-collateral.
- **Action:** characterize; confirm it does not recur outside a saturation window before treating as a real signal.

### 3. [info / regression-watch datapoint] Active saturation spike ~00:00–00:14Z 08-14
- **Source:** `pipeline_runs` ok=false last 6h — 19 pipelines timing out simultaneously ~00:00–00:09Z, all pure saturation signature (`statement timeout` / `Timed out acquiring connection from connection pool` / `upstream request timeout`). Includes `refresh-insights-cache` (deals/cross_collection board), `fmv-recalc` (lock timeout), `refresh_wmc_fmv_changed`/`_drift_active` (27/15 — now logging their own rows, the cd1018f0 observability fix working), and 2 pg_cron MV refreshes (`rpc-refresh-misattrib-candidates` 1/1, `rpc-refresh-allday-pack-realized` 1/4 intermittent, self-heals on quiet ticks).
- **Concrete (transient) loss:** `wallet-backfill-allday` `rows_lost=800`, `wallet-backfill-pinnacle` `rows_lost=80` under pool-acquire timeout — re-filled on next successful cadence walk.
- **Risk:** none new. Same well-documented Small-compute disk-IO-budget class; the durable fix (shared materialize-latest-FMV / per-board precompute) is already CC-owned. Logged as a fresh datapoint for the night pass's post-ship/regression watch (this window is live as the pass approaches ~01:00 PT), NOT a new fix request.

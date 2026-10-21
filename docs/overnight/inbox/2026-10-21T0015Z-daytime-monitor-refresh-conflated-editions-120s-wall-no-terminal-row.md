# Candidate — refresh-conflated-editions 120s wall writes no terminal pipeline_runs row (stalled-detector fires, guard data fresh)

**Filed:** 2026-10-21T00:15Z · daytime health monitor (read-only) · infra GREEN otherwise
**Priority:** LOW (instrumentation / route-duration; no data-freshness or user-facing impact)

## What
`detect_stalled_pipelines()` / `rpc_ops_snapshot().stalled_pipelines` flags `refresh-conflated-editions`:
- `classification: invoked_but_never_logged`, `silent_minutes: 1969`, `max_silent_minutes: 1800`
- last TERMINAL `pipeline_runs` row: 2026-10-19T15:17Z; an uncorrelated heartbeat landed 2026-10-20T15:17Z (`uncorrelated_heartbeats: 1`)
- Vercel runtime-error group confirms the mechanism: `Vercel Runtime Timeout Error: Task timed out after 120 seconds`, route `/api/cron/refresh-conflated-editions`, last 2026-10-20T15:17:13Z (count 1/24h = the single daily 08:17 PT / 15:17 UTC tick).

So the route is killed at its 120s Vercel wall before it writes its terminal `log_pipeline_run` row — the exact "maxDuration kill writes none" shape the watchlist entry was armed to catch (the 09-19/09-20 class).

## Why it is NOT harmful (verified this pass)
The watchlist detail says promote medium->high only if a stale thin-FMV set is traced to a confident deal-board price. That harmful direction is NOT present — both guard tables are fresh at read time:
- `topshot_thin_fmv_editions`: computed_at 2026-10-20T15:19Z (8.8h), 19 rows — written ~2 min after the 15:17 tick, AND independently refreshed daily by pg_cron `rpc-refresh-thin-fmv-guard` (08:30 UTC), which SUCCEEDED on 10-20 and every day 10-13 -> 10-20 (`check_pgcron_recent_failures()` = []).
- `topshot_conflated_editions`: detected_at 2026-10-20T20:31Z (3.6h), 111 rows — refreshed by the 6-hourly `23 */6` remap, independent of the Vercel route.
Trust-health thin/conflation metrics all `ok`; `fmv_sanity_flags` 0; `public_board_empty_count` 0. No user-facing impact.

## Risk read
LOW. The route's WORK lands (guard tables fresh via two independent paths); only its own terminal health row is missing, so `detect_stalled_pipelines` will keep firing every pass until the route logs a terminal row or the watch is reconciled. NOT a spell — `rpc_ops_snapshot()` and every probe returned promptly, and the cause is confirmed by the Vercel 120s timeout, not inferred under saturation.

## Suggested action (night pass / Trevor — sense-only, not shipped here)
Classify, then pick one:
(a) move `log_pipeline_run(... ok=true ...)` to fire BEFORE the heavy conflation step (or emit a terminal row on the heartbeat) so a 120s kill still records health;
(b) chunk the conflation work so the route finishes under the 120s Vercel wall;
(c) reconcile `pipeline_cadence_watchlist` for `refresh-conflated-editions` given the pg_cron `rpc-refresh-thin-fmv-guard` backstop already covers the thin half and the `23 */6` remap covers conflation independently.
Re-verify guard freshness (`topshot_thin_fmv_editions.computed_at`, `topshot_conflated_editions.detected_at`) before any change. No revert path (read-only observation).

**Source:** `rpc_ops_snapshot().stalled_pipelines` + `detect_stalled_pipelines()`; Vercel runtime-error group `/api/cron/refresh-conflated-editions` (120s timeout, last 2026-10-20T15:17:13Z); guard-table freshness + `cron.job_run_details` for `rpc-refresh-thin-fmv-guard`.

## Drained 2026-10-20 — fix already shipped; verify on the next tick
The daytime pass raised the route to 300 s (`4392d28`, 10-20 12:22 PM PT) after the 8:17 AM PT kill, so this filing reads the last pre-fix tick. Verify on the 10-21 8:17 AM PT run: a terminal `refresh-conflated-editions` row with `ok=true` and `lanes_failed` []; `detect_stalled_pipelines()` should then drop it. Re-read ~8:00 PM PT 10-20 (Cowork cloud): guard tables fresh, stalled-detector row still present as expected until that tick.

# Daytime monitor — 2026-11-14 22:11Z

**Overall: GREEN bar one self-inflicted monitor-accuracy regression from today's own ship.**
Security x4 clean (`invariants`/`anon_write_holes`/`rls_off_base_tables`/`secdef_anon_violations` all `[]`).
`detect_stalled_pipelines()` `[]` · `check_pgcron_recent_failures()` `[]` · sentinel ts_uuid editions 48h `0`.
pipeline_fails_24h all `upstream:0` (403-collateral class); pipeline_alerts 9 rows all severity `info` (the designed
Cloudflare 403/404/400 + moved-Moment 400 class, all attributed, fresh 200s landing). Vercel: no ERROR deploys in the
last 12 (READY + CANCELED only; CANCELED = docs/migration-only or redeploy-superseded); prod serves last code READY.
Dashboards: roster clean (16 `docs/cowork-skills/*.html` = 13 live + 3 intentionally-excluded retired sources),
and **13/13 live dashboards' SQL objects all resolve** (65 relations + 10 functions checked, 0 missing). Sentry dark (known).
db 51,619 MB. Not a saturation spell (positive control io_wait 5 / active 6, tiny absolute, every query instant/no timeout).

---

## HIGH-PRIORITY candidate — `board_mv_refresh_stale_hours` false BREACH (2502.8h) introduced by today's own perfect-mint refresh-logging ship

**Title:** The perfect-mint MV refresh was repointed from a bare `REFRESH … <mvname>` to a wrapper function call, which no longer contains the literal `mv_` matview name, so `board_mv_refresh_max_stale_hours()`'s `command ILIKE '%'||matview_name||'%'` join misses, falls back to `watchlisted_at`, and reports a permanent 2502.8h BREACH — while the board is actually fresh.

**Source:**
- Trust-health metric: `public.v_rpc_trust_health` row `board_mv_refresh_stale_hours` = 2502.77h, status BREACH (breach_at 8). Surfaced in `rpc_ops_snapshot().trust_health_breaches` = `["board_mv_refresh_stale_hours"]`.
- Offending board: `mv_topshot_perfect_mint_premiums_board` (backs `/insights/serial-premiums` "perfect mint" + `/insights/perfect-mint-premiums`). Per-row breakdown: this MV has `active_job_id = NULL` under the metric's join; all 8 other watchlisted boards match their job and read 0.3–2.0h fresh.
- Causing ship: ledger 2026-11-14 entry, migration `20261114212002_audit_20261114_perfect_mint_premiums_refresh_logs_its_run` (shipped ~20:35–20:55 UTC / ~1:35–1:55 PM PT today). It replaced the bare `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_topshot_perfect_mint_premiums_board` with new `public.refresh_topshot_perfect_mint_premiums_board()` and "repointed the job's command BY NAME" to `SELECT public.refresh_topshot_perfect_mint_premiums_board()`.
- Attribution (deterministic, not a timing read): the wrapper-function name `refresh_topshot_perfect_mint_premiums_board` does NOT contain the substring `mv_topshot_perfect_mint_premiums_board` (missing the `mv_` prefix), so the metric's `command ILIKE` join can no longer find an active job for this MV and falls back to `watchlisted_at` (2026-08-02 → 2502.8h). cron.job_run_details confirms the cutover: the 20:00 UTC run shows the old tag `REFRESH MATERIALIZED VIEW`; the 22:00 UTC run shows `1 row` (the new function) — the breach appeared exactly at that repoint. jobid 236 `rpc-refresh-perfect-mint-premiums` is active, schedule `0 */2 * * *`, succeeded 22:00:11Z.

**Why it is NOT a board-down (verified):** `mv_topshot_perfect_mint_premiums_board` has 43 rows and was refreshed successfully at 22:00Z (~minutes before this read). The board's REAL freshness is now independently protected by the SAME ship's new `pipeline_cadence_watchlist` row (`topshot-perfect-mint-premiums-mv`, 300 min silent / 600 without success) via `log_pipeline_run(...)`. So for this one MV the `board_mv_refresh` metric is now both BROKEN and REDUNDANT.

**Risk read:** LOW blast radius today (no user-facing staleness), but HIGH monitoring cost if left: this is a permanent trust-health BREACH that will fire on every daytime-monitor run and every nightly trust-health read, and — the exact failure the metric's own `catches` text warns about — it makes a genuine future perfect-mint board-down indistinguishable from this benign false positive (alert fatigue / cry-wolf). Fix is low-risk and mechanical.

**Suggested action (night pass / Trevor — sensing only, not applied):** pick one, all low-risk:
1. Teach `board_mv_refresh_max_stale_hours()`'s join to also match the refresh-function spelling (e.g. match `command ILIKE '%'||replace(matview_name,'mv_','refresh_')||'%'` in addition to the literal MV name), so a wrapper-function-call command is recognized — most general, fixes the whole class for any future MV moved to a logged-refresh wrapper.
2. Or add the literal MV name as an inline SQL comment in jobid 236's command (`SELECT public.refresh_topshot_perfect_mint_premiums_board(); -- mv_topshot_perfect_mint_premiums_board`) so the existing `ILIKE` join matches — smallest change, one cron.alter_job.
3. Or deactivate this MV's `board_mv_refresh_watchlist` row (`is_active=false`) since `pipeline_cadence_watchlist` now covers its freshness — removes the redundancy but loses the outcome-based (unscheduled/dropped) catch that the cadence watch can't see; option 1 is preferred for keeping that coverage.

Acceptance test for any fix: `SELECT value,status FROM v_rpc_trust_health WHERE metric='board_mv_refresh_stale_hours'` returns < 6h / ok, AND a deliberately-broken job (deactivate 236) still drives it to BREACH.

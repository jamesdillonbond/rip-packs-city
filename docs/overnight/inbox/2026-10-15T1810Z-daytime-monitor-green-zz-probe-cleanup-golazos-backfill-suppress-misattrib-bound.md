# Daytime monitor candidates — 2026-10-15T18:10Z

Source: rpc-daytime-health-monitor (read-only ~3h sweep). Sweep was GREEN — security 4/4 clean, trust 38/38 ok (0 breaches), 0 stalled pipelines, 0 pg_cron failures, last prod deploy READY, 11/11 artifact backing surfaces resolve. NOT a saturation spell (rpc_ops_snapshot returned fast and complete), so the reads below are interpretable. Three low-risk candidates for the night pass.

## 1. LOW · Drop (or pin search_path on) leftover probe function `zz_probe_20261014()`
- Source: `rpc_ops_snapshot().function_search_path_drift`; `pg_get_functiondef` = `CREATE OR REPLACE FUNCTION public.zz_probe_20261014() RETURNS integer LANGUAGE sql AS $$select 1$$`.
- What: a leftover `select 1` probe from 10-14 with no `search_path` in proconfig, so it trips the `function_search_path_mutable` advisory. SECURITY INVOKER, so advisory/correctness only, not an escalation. Not referenced by any ledger entry, pin, or do-not-flag steer.
- Risk: trivial (unreferenced no-op probe).
- Suggested action: `DROP FUNCTION public.zz_probe_20261014();` (confirm no references first); or if intentionally kept, `ALTER FUNCTION public.zz_probe_20261014() SET search_path = public, pg_temp` (an ALTER, not CREATE OR REPLACE).

## 2. LOW · Bound-suppress the finished `golazos_sales_v1_backfill` cursor_stalled HIGH
- Source: `rpc_ops_snapshot().pipeline_alerts` -> `{type: cursor_stalled, severity: high, "Cursor updated 14 days 17:29 ago at block 137390146"}`.
- What: `golazos_sales_v1_backfill` is NOT on the cadence watchlist (`detect_stalled_pipelines()` returned []), i.e. a finished one-time historical backfill -- same class as `topshot_offers_history_backfill` / `topshot_missing_fill_offers_walk`, bound-suppressed on 10-11 (`20261011144350`). It raises a standing HIGH on every sweep for a walk that is done.
- Risk: low (suppression only) -- but VERIFY done-state first.
- Suggested action: confirm the backfill is done (fixed block, no re-dispatch planned), then add a bounded suppression matching the 10-11 pattern; re-open only if the cursor MOVES.

## 3. LOW · Re-tune the stale `topshot-misattrib-drain` suppression bound (<=500)
- Source: `rpc_ops_snapshot().suppression_count_predicate_drift` (observed 705 vs predicate "open misattribution candidates (no on-chain map row) <= 500"); corroborated by `topshot_misattrib_backlog_history`.
- What: NOT a regression. The open backlog is draining steadily -- open_count 2129 (10-09) -> 1544 -> 1196 -> 970 -> 729 -> 705 (10-14), with left_open > entered_open every day since the Atlas resolver shipped 10-10. The <=500 bound lags the still-draining backlog, so it fires a drift signal on every sweep while the lane is healthy.
- Risk: low (threshold tune).
- Suggested action: leave it to self-clear below 500 (~a week at the current rate), or re-point the suppression bound to ~800 so it stops crying wolf; do NOT treat as a data regression.

---
Observed-healthy, no action: Candy OpenSea indexers 5/5 fail = keyless-dormant BY DESIGN (shipped 10-10 "dormant until a key is set"); panini-collector-walk per-walk-cap = by design; sync-nba-projections fails muted to 10-28; atlas-*-upstream-403 + flow-rest-moment-moved-400 = INFO, self-healing/by-design; Vercel CANCELED builds = superseded rapid commits. Sentry connector not authorized this run (not swept).

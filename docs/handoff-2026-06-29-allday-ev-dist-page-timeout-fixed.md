# AllDay dist-page EV timeout — FIXED via matview precompute (2026-06-29, Cowork)

Resolves the two CC-flagged queued perf items: **ALLDAY-CORRECTED-EV** + **ALLDAY-PACK-REALIZED-EV-DIST-PAGE-TIMEOUT** (heavy per-request EV aggregations timing out on the AllDay dist page).

## Root cause (measured)
`v_allday_pack_info` single-dist read = **2,660 ms**. The cost was `v_allday_pack_ev_corrected`'s `tier_stats`/`circ` CTEs: they scan the full `fmv_current` merge (DISTINCT ON over ~736k `fmv_snapshots_2026` rows) **twice**, compute every dist, then filter to one — no predicate pushdown into the heavy CTE.

## Fix (DB-only, same values — a cache, not a logic change)
- **`mv_allday_pack_ev_corrected`** — materialized view of the exact `v_allday_pack_ev_corrected` query (all dists computed once) + `UNIQUE INDEX (dist_id)`.
- **`v_allday_pack_ev_corrected`** redefined as a transparent passthrough `SELECT * FROM mv_allday_pack_ev_corrected` (security_invoker, same columns/types) — so `v_allday_pack_info` and `v_allday_pack_realized_ev` are unchanged but now read a single indexed row.
- **Refresh cron** `rpc-allday-ev-corrected-refresh` (pg_cron jobid 28, `23 */6 * * *`, `REFRESH MATERIALIZED VIEW CONCURRENTLY`). EV changes slowly (FMV/pool/odds), 6h is ample; CONCURRENTLY needs the unique index (present), no read-blocking.

## Result (re-measured)
- `v_allday_pack_info` single dist: **2,660 ms → 145 ms** (18×). Remaining 140ms is the shared `pack_ev_latest` view (DISTINCT ON over `pack_ev_history`) — platform-wide, out of scope, well under any timeout.
- `v_allday_pack_realized_ev` single dist: **→ 0.2 ms** (was a flagged timeout; it reads the matview index + the small `pack_rips` bitmap).
- Security invariants 0; matview is relkind 'm' (not flagged by the base-table/view invariants); granted SELECT to anon/authenticated/service_role.

## Revert
```
DROP VIEW public.v_allday_pack_ev_corrected;  -- then recreate the pre-matview view def (in migration history: audit_20260629_allday_pack_ev_corrected_tier_median)
DROP MATERIALIZED VIEW public.mv_allday_pack_ev_corrected;
SELECT cron.unschedule('rpc-allday-ev-corrected-refresh');
```
Note for night-pass/monitor: the matview + its 6h refresh cron are intentional. If corrected-EV ever looks stale, check the last refresh / force `REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_allday_pack_ev_corrected;`. The same matview pattern is the template if Top Shot's corrected-EV is ever surfaced per-dist.

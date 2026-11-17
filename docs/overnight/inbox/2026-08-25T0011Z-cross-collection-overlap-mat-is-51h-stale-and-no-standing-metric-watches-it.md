# cross_collection_ts_set_overlap_mat is ~51h stale, and no standing instrument watches it

**Source:** rpc-daytime-monitor, 2026-08-25T00:11Z tick (not first-tick, so the 1a ccm verify did not run). Observed via the rpc-live-health payload (`cross_collection_cohort_stats` thin) → drilled into the two ccm MVs and `check_pgcron_recent_failures()`.

## What was observed (measurement, not conclusion)
- `cross_collection_cohort_mat`: **220 rows, computed_at 2026-08-24 23:10Z** (~1h old) — step1 (`rpc-ccm-step1`) is healthy.
- `cross_collection_ts_set_overlap_mat`: **260 rows, computed_at 2026-08-22 20:43Z** — **~51h stale** against the skill's 26h freshness bar. This is the exact "step1 fresh + step2 stale" signature the 1a routine calls out = step2 specifically failing.
- `check_pgcron_recent_failures()` shows `rpc-ccm-step2` **failed 2026-08-24 23:25Z** with `canceling statement due to statement timeout` on `CREATE TEMP TABLE _ccm_step2_next ON COMMIT DROP AS SELECT e.set_id, MAX(e.set_name), COUNT(DISTINCT ...) GROUP BY ...`.
- Spell positive control at the same time: `io_wait=0, active=0` — **not** in a saturation spell at read time.

## Root cause is ALREADY KNOWN — do not re-investigate it
The step2 statement-timeout is a disk-IO saturation symptom. It is already filed (`inbox/2026-08-18T1835Z-the-wmc-backfill-starvation-is-fixed-by-scoping-and-the-ccm-timeout-was-saturation.md`) and focus.md PRIORITY 3 explicitly bars opening new investigations into pg_cron statement-timeouts as they share one root (SMALL-instance IO budget; the lever is cutting the query's work, never raising the timeout or upgrading the tier). **This candidate is NOT a request to chase the timeout.**

## The NEW, actionable part: a monitoring gap (low risk)
`cross_collection_ts_set_overlap_mat` freshness is watched by **nothing standing** — it is absent from `v_rpc_trust_health` / `rpc_ops_snapshot()` (the snapshot's `board_mv_refresh_stale_hours=5.84 ok` tracks a different MV set), and is only surfaced by the manual first-tick 1a ccm verify. So between ~8am ticks the overlap surface can serve multi-day-stale data invisibly (as now, 51h).

**Suggested action (night pass / Trevor's call — a decision, not a diagnosis):** add an overlap_mat freshness arm to `v_rpc_trust_health` (e.g. `cross_collection_overlap_stale_hours`, breach ~30h) so this staleness is caught continuously rather than twice a day. This is a monitoring add, independent of whether/when the underlying step2 query gets cut down. If the overlap surface is judged low-traffic enough not to warrant a sentinel, record that decision so this stops being re-derived each first-tick.

**Risk read:** low. Read-only observation; the only proposed change is an additive trust-health metric (no user surface, no data mutation).

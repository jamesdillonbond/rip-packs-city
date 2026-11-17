# `pack_ev_history` grows ~187k rows/week and 77 % of them repeat the previous snapshot exactly — proposal to thin old identical runs (needs Trevor's yes; NOT applied)

Filed 2026-11-15 ~3:11 PM PT by Claude Code cloud (autonomous pass). Read-only measurement; nothing changed.

## What was measured

- `pack_ev_history`: ~1.41M rows, 901 MB, 4,877 pack keys, **no pruning anywhere** (no pg_cron job, no function deletes from it). Weekly inserts: ~25k/week through 10-04, **~185–188k/week since 10-12** (the hourly `refresh_atlas_pack_ev`, job 217, writes one row per Atlas dist per hour: 971 dists).
- Rows byte-identical to the same pack's previous snapshot (15 value columns: price, gross/pack/typical EV, flag, ratio, coverage, edition count, unopened, depletion, primary/secondary price + availability, price source): **78.7 %** of the last 2 days (42,697 / 54,274); **77.0 %** of the week of 10-19 are *interior* points of an identical run (142,889 / 185,463 — same value as BOTH neighbours).
- Cost it drives, today: `analytics_packs_summary` reads the newest row per pack over the whole table — key pass 1.41M index entries / 30k buffers, then 4,877 scattered fetches (2.1 s warm for the narrow covering index alone); its post-deploy cold calls hit service_role's 30 s cap (6 × 500 on 11-15 1:58 / 2:06 PM PT, the e2e sweep). `refresh_mv_pack_ev_latest` (job 73, every 30 min) does the same DISTINCT ON. Both grow linearly with the table.

## Proposal (two parts, both Trevor's call)

1. **One-off thinning** of rows older than 14 days that are interior points of an identical run (value = previous = next for the same `pack_listing_id`). Keeps every run's first and last row, so a time series drawn from the table is the same step function, every pack's newest row is untouched (no "latest" reader can change), and first-seen/last-seen of each value survive. Estimated ~1.0M of ~1.3M rows since 10-05. Shape: back up to `audit_<date>_pack_ev_history_thinned` (RLS on, no grants), DELETE in id-batches of ~20k from pg_cron or a DO loop (never one statement; `pack_ev_history` is read hourly), `VACUUM (ANALYZE)` after.
2. **A weekly job** doing the same for the week that just turned 14 days old.

## What must be checked first (why this is not shipped)

- **Equivalence for COUNT-based readers.** 15 functions and 5 views read the table: `analytics_packs_fresh`, `analytics_packs_history`, `analytics_packs_summary`, `analytics_packs_top_ev`, `analytics_pipeline_health`, `backfill_topshot_historical_pack_ev`, `compute_pack_ev_from_pool(_tier_weighted)`, `get_pack_ev_history`, `get_pack_realized_ev_row`, `refresh_atlas_pack_ev`, `refresh_container_pack_ev`, `refresh_mv_pack_ev_latest`, `rpc_thp_leg_pack_ev`, `rpc_trust_health_precompute_refresh`; views `pack_ev_latest`, `mv_pack_ev_latest`, `topshot_pack_ev_targets`, `v_topshot_atlas_pool_targets`, `v_rpc_trust_health`; app: `/api/pack-ev`, `/api/packs`, `/api/pack-ev-history`, the pack-dist page, `lib/pack-dist-verdict.ts`, `lib/pack-ev-pricing.ts`, `lib/pack-dist-odds.ts`, 4 compute edge functions. Any that COUNTS snapshots (e.g. "hours +EV", snapshot counts per day) or averages over them would change; latest-row and step-series readers would not. Read each body before applying.
- **Do NOT instead make the writer skip unchanged rows**: public readers gate on a 72 h freshness bar (`snapshotted_at`), so an unchanged pack would drop off the boards after 3 days.
- It is a ~1M-row DELETE on a hot table: off-limits for the night pass, and the MCP destructive prompt has not reached Trevor today.

## Re-check before acting

Re-run the two percentages (queries: lag/lead over `row(<15 cols>)::text` partitioned by `pack_listing_id`); they are dated samples.

## Addendum ~3:36 PM PT — the biggest current cost

`rpc-refresh-mv-pack-ev-latest` (job 73, every 30 min, a DISTINCT ON over the whole table): **31.6 s average, 58.2 s max over the last 24 h, 48 runs, 0 failures** — ~25 min of database time a day, and it scales with the row count. Thinning ~77 % of old rows would cut that read proportionally (re-measure after, by duration and BUFFERS).

## ✅ RESOLVED — 2026-11-15 ~5:55 PM PT (Claude Code, Trevor's laptop; Trevor: "work through it all")

Applied as `20261116014326` (`audit_20261115_pack_ev_history_thin_identical_runs`). Both parts are done. Two changes from the proposal: the comparison covers **every** column except `id` and `snapshotted_at` (not just the 15 value columns, so `pack_name`, `dist_id` and `collection_id` are included and every filtered "newest row" reader is provably unchanged), and the recurring job is **daily**, not weekly, so it stays inside `pipeline_runs`' ~73 h window and can be watched.

- **Readers re-audited:** 15 functions, 5 views, app routes. None counts or averages snapshots over time. The pack-count metric (`count(DISTINCT pack_listing_id)`) and `max(snapshotted_at)` per dist cannot move.
- **Proven before the real run (rolled back):** one 200-pack batch deleted 27,985 rows. It left each pack's newest row byte-identical, left the newest row passing `pack_ev_latest`'s filter identical, and left every pack's value at every hour of October identical.
- **One-off:** `thin_pack_ev_history_chunk('-infinity', '2026-11-01 00:00 UTC', …, record=true)`, 25 batches via a one-shot pg_cron job (890, unscheduled after). **691,464 rows deleted in 62 s.** The table went from 1,414,513 to 723,049 rows. Packs 4,877 → 4,877; `pack_ev_publish_shortfall_pct` 0.49 → 0.49. `VACUUM (ANALYZE)` was run.
- **Backup:** `audit_20261115_pack_ev_history_thinned` (id, pack, timestamp: 691,464 rows, RLS on). It is enough to rebuild every row exactly. The revert INSERT is in the migration header.
- **Recurring:** pg_cron 889 `rpc-pack-ev-history-thin`, daily at 5:01 AM PT. It thins rows that have just turned 14 days old, reading a 17 d → 12 d slice only. Heartbeat `pack-ev-history-thin-heartbeat`, completion `pack-ev-history-thin` (rows_written = deleted).
- **Cost, first read:** job 73's first run after the thin (6:03 PM PT) took 23.8 s, against 26.6–34.9 s for the six runs before. That is one sample, and a smaller drop than the 49 % row cut, so the matview refresh is not dominated by the history scan alone. Re-read a day of job 73 durations, plus blocks per call from pgss, before calling it. `analytics_packs_summary` measured 355 ms / 54k buffers just after (pgss lifetime mean 3.5 s / 65k).

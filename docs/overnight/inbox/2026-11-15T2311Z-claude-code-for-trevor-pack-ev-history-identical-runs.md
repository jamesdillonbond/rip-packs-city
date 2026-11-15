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

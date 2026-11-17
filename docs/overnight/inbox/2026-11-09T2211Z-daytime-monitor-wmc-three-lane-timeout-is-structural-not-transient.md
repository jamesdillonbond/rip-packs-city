# daytime monitor — the three-wmc-lane morning timeout cluster is STRUCTURAL (wmc +1.4M rows in a day, planner stats absent), not the transient contention the 16:06Z filing read

**Filed:** 2026-11-09 ~22:11Z by rpc-daytime-monitor (read-only daytime pass)
**Severity read:** LOW/MEDIUM, non-urgent, nothing user-facing. This ADDS the diagnosis half to `2026-11-09T1606Z-daytime-monitor-wmc-editions-statement-timeout-cluster.md` — treat the two as one item, not two.

## Why this is NOT a saturation symptom (unlike the 16:06Z read)
The 16:06Z filing applied 1c discipline and filed the three-lane cluster (`wmc-player-names-follow-catalog` 10:29Z, `wmc-metadata-selfheal` 10:31Z, `topshot-map-atlas-reconcile` 12:47Z — all ok yesterday, all bare `statement timeout` today) as *likely transient contention*, deferring the cause to a quiet-window re-measure. Reads at ~22:05–22:10Z, hours later and NOT in a spell (`rpc_ops_snapshot()` returned; every probe fast; positive control earlier read io_wait 3 / active 8), show the cause is structural and standing, not a morning band:

- `wallet_moments_cache` is now **3,630,131 rows / 5,755 MB** (pg_class estimate). The 11-08 ledger recorded it at **2.25M rows / 2.6 GB** before the Candy full-inventory census, so it grew **~1.4M rows / ~+3.1 GB in a day** — exactly the +1.37M Candy rows the 11-08 census entries describe.
- `pg_stat_user_tables.last_analyze` on the table is **NULL** — the planner has no fresh stats for a table that just grew ~60%. All three lanes full-scan-join over it (wmc join editions join people), so they plan against stale/absent statistics.

A lane that measured **2.8 s / 126k buffers on 11-08** (the #221 heal, ledger) does not become a hard statement-timeout from contention alone; a ~60%-bigger table with no stats is a sufficient, standing cause. Expect the cluster to recur on every daily tick until addressed, not clear on the next one.

## Suggested action for the night pass (hypothesis to measure, not ship)
Same levers the 16:06Z filing named, now with a concrete first step:
1. `ANALYZE public.wallet_moments_cache;` and confirm autoanalyze is keeping up now that it is +1.4M rows — cheapest thing that may restore the plans.
2. If still near-budget after fresh stats, give each daily wmc lane a row-budget / batch (the `candy_wmc_label_fill_step` pattern, `20261109044329`), and/or move the 10:00–13:00Z slots off the census/label-fill writer band.
3. Confirm in a quiet window with `EXPLAIN (ANALYZE, BUFFERS)` on each lane's statement that the plan binds within statement_timeout post-ANALYZE.

No revert — reads only, nothing shipped.

## Blast radius if left (unchanged from 16:06Z)
Internal self-heal lanes only, each self-correcting on its next successful tick: Atlas mis-attribution repair (~83 rows/day), metadata selfheal (~3 rows), #221 player-name catalog-follow. No user-facing, security, accuracy-gate or deploy impact. Low — but it will keep failing daily, not once.

## Cross-refs
- `2026-11-09T1606Z-daytime-monitor-wmc-editions-statement-timeout-cluster.md` (the cluster; this is its diagnosis)
- ledger 2026-11-09 "candy-census `wallet_moments_cache` lock-contention" (MED, Claude Code)
- ledger 2026-11-08 Candy full-inventory census ships (the +1.37M wmc rows)

## ↳ 2026-11-09 ~3:30 PM PT — Claude Code cloud re-measure: the "stats NULL" mechanism is REFUTED; the cause is one lane's full-table candidate scan

- **Stats are fresh.** The filing read `last_analyze` (manual ANALYZE only). `last_autoanalyze` = 2:59 PM PT today, `last_autovacuum` = 3:18 PM PT, `n_mod_since_analyze` 36,788 of 3.61M, `relallvisible/relpages` 156,456 / 160,518 (97 %). Running `ANALYZE` (lever 1) would change nothing.
- **Only ONE of the three lanes failed.** pg_cron 11-09: `rpc-wmc-player-names-follow-catalog-daily` (834) **failed** (statement timeout); `rpc-wmc-metadata-selfheal-daily` (726) and `rpc-topshot-map-atlas-reconcile` (818) report **succeeded** but at exactly 120 s (they catch the timeout internally; read their `pipeline_runs` row, not the cron status).
- **The cause in 834:** `heal_wmc_player_names_from_catalog` builds its candidates by joining EVERY non-Pinnacle wmc row to editions → players and reading `player_name` from the heap. The Candy census added ~1.4M rows; the Candy slice alone exceeds 55 s (measured, `statement_timeout` 55 s). With few real candidates the `LIMIT` never short-circuits, so the scan is the whole table.
- **Candy cannot simply be excluded:** 43 Candy editions have `editions.player_name` ≠ the linked `players.name`, so the heal has real Candy work.
- **The fix is a bounded walk**, not stats: a cursor-paged step over (collection, edition_key) with a row/edition budget on `idx_wmc_coll_ek_serial_cover`, scheduled often enough to finish a pass in a day (the `candy_wmc_label_fill_step` shape). It is a three-file change (migration + verbatim pin `supabase/tests/heal_wmc_player_names_from_catalog.sql` + drift guard). Not shipped in this pass — offered to Trevor. Blast radius unchanged: internal self-heal, ~0–100 rows/day.

## ↳ 2026-11-09 ~4:15 PM PT — FIXED (Claude Code cloud)

`heal_wmc_player_names_from_catalog` now walks a bounded slice behind `wmc_player_name_heal_cursor` (~20k wmc rows / call on the existing unique index), and pg_cron 834 runs it every 5 min (`2-59/5`) instead of once a day — migration `20261110000023_audit_20261109_wmc_player_names_heal_walks_a_bounded_slice`, pin rewritten (planted defects red). First production ticks: 4:02 PM PT 8.7 s / 252 keys / 20,050 rows, 4:07 PM PT 33.4 s / 213 keys / 20,279 rows (vs the 120 s timeout at 2:29 AM PT). A full pass ≈ 3.6M rows / 20k ≈ 180 ticks ≈ 15 h. The other two lanes in this filing reported `succeeded` at 120 s (they catch their own timeout) — their `pipeline_runs` rows are the thing to read next.

## ↳ 2026-11-09 ~4:35 PM PT — the other two lanes: real failures, fix STAGED (not applied)

Their own `pipeline_runs` rows read ok=false, "canceling statement due to statement timeout", on 11-09 (pg_cron said `succeeded` because they catch the error). **`wmc-metadata-selfheal`** (726): its UPDATE matched every recent row with ANY NULL label whether or not fillable; 103,620 of 105,075 fillable rows in its 3-day window are Candy, already owned by `candy_wmc_label_fill_step`. Skipping Candy on the editions side + the fillability test → 388 ms for the 1,420 non-Candy rows. **`topshot-map-atlas-reconcile`** (818): the candidate scan alone is 53 s / 4.67M buffers (all 1.93M Atlas nba events) — growth, not Candy; lever = a 300 s statement_timeout on its daily cron command. Both in `docs/proposals/wmc-selfheal-skips-candy-STAGED.sql` — `apply_migration` was blocked by an unanswered confirmation prompt this session (see `docs/proposals/STAGED-2026-11-09-README.md`).

## ✅ RESOLVED — verified 2026-11-10 ~12:12 PM PT (Claude Code cloud, read-only)

All three lanes of the cluster are clean in the last 24 h of `pipeline_runs`: `wmc-player-names-follow-catalog` 243 ok / 0 failed (bounded-slice walk, max 36.3 s); `wmc-metadata-selfheal` 1 ok / 0 (2:31 AM PT, 39.1 s — after the 11-09 "selfheal skips Candy" fix); `topshot-map-atlas-reconcile` 1 ok / 0 (4:47 AM PT, 175.5 s under its 300 s budget — the growth watch for this lane lives in focus.md's 11-10 steer, with its covering-index lever). Treat 1606Z + 2211Z as one closed item.

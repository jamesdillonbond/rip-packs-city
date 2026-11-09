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

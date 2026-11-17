# The nightly reconcile is failing and the cards are stale — but the proposed query-shape fix is REFUTED by measurement

Claude Code, interactive, 2026-08-15 10:00 PT (17:00Z). Raised by a scheduled Claude task ("check 7 failed
the last two nights"). **Acted on: drained 24 of the stale wallets live.** No schema change, no migration.

## Confirmed, and it is user-facing

`rpc-reconcile-saved-wallet-stats` (pg_cron, 13:33Z / 06:33 PT) last succeeded **2026-08-13**; 08-14 died on
`statement timeout`, 08-15 on `job startup timeout`. `saved_wallets.cached_moment_count` / `cached_fmv_usd` /
`cached_top_tier` back the dashboard, `/profile` and `/share` cards, so every hour it does not run those
cards understate real collections.

**Drift measured at 17:00Z (99 saved wallets, 21 users):** 58 stale >24 h · 40 stale >48 h · oldest **156 h
(6.5 days)**.

**After draining this session:** **34 stale >24 h · 21 stale >48 h**, 24 wallets refreshed. The remainder are
the large/cold wallets — see why below.

## Three corrections to the task's suggested next actions

1. ⚠ **`SELECT reconcile_all_saved_wallet_stats();` cannot work.** It is a **PROCEDURE**, not a function, and
   it takes three required arguments. The correct invocation is bounded and is the reason it is safe to run
   during a spell:
   ```sql
   CALL reconcile_all_saved_wallet_stats(p_max_seconds => 45, p_max_wallets => 30, p_min_age_minutes => 60);
   ```
   ⚠ It **COMMITs internally**, so it must be the ONLY statement in its call — batching several in one
   multi-statement request fails with `2D000 invalid transaction termination`.
2. ⚠ **"Commit per-wallet rather than one large UPDATE" is ALREADY DONE.** The procedure iterates wallets and
   commits per wallet (that internal `COMMIT` is exactly what 2D000 exposes). The failure is not one big
   UPDATE — it is **a single wallet's aggregation exceeding the statement budget**.
3. ⚠ **THE HEADLINE — making the per-wallet aggregation "cheaper" by fixing its query shape is REFUTED.**
   `aggregate_saved_wallet_stats` computes `top_tier` with a **correlated subquery per collection_id** on top
   of the group scan, which looks like the obvious N+1 to eliminate. I wrote the single-pass replacement
   (`array_agg(... ORDER BY tier_rank) FILTER (WHERE tier IS NOT NULL))[1]`, one scan, no correlated
   subquery) and measured it on a stuck wallet:

   ```
   GroupAggregate (actual time=3208.850..73983.556 rows=4 loops=1)
     Buffers: shared hit=1183 read=11457 dirtied=63 written=821
     ->  Index Scan using idx_wmc_lock_wallet_coll  (actual time=8.553..73753.238 rows=14260)
   Execution Time: 73983.816 ms
   ```

   **74 seconds for 14,260 rows — with the N+1 already removed.** 11,457 buffer *reads* against 1,183 hits is
   a **9 % cache hit ratio**: this is cold disk I/O on the throttled Small instance, not plan cost. Rewriting
   the function would ship churn against a live pinned DB object and fix nothing. *A cost estimate is not a
   measurement.*

## What would actually help, in order of confidence

1. **Move the job off the congested slot.** The same saturation now has a documented *schedule* — see
   [`2026-08-15T1630Z-three-heavy-pg-cron-jobs-collide-at-minute-13.md`](2026-08-15T1630Z-three-heavy-pg-cron-jobs-collide-at-minute-13.md),
   which found 15 backends all blocked on `DataFileRead` with three heavy pg_cron jobs stacked. This job at
   :33 is a second cluster. **Cheapest real fix, one `cron.alter_job`, and it needs the same approval that
   file is waiting on** — worth bundling into one decision rather than two.
2. **Let it run bounded and often, instead of once and big.** The procedure already takes
   `p_max_seconds` / `p_max_wallets` / `p_min_age_minutes`. A smaller budget on a *more frequent* schedule
   converges the same backlog without ever presenting a >45 s statement — which is what I did by hand here,
   and it worked while the instance was actively saturated. This needs no code, only a schedule change.
3. **Only then consider I/O.** An index-only path (`wallet_moments_cache(wallet_address) INCLUDE
   (collection_id, fmv_usd, tier)`) would cut the 11,457 heap reads — but ⚠ CLAUDE.md's standing note is that
   INCLUDE columns block HOT updates on this exact 2.3 GB hot table, so it is a real trade, and a
   `CREATE INDEX CONCURRENTLY` must wait for a genuinely quiet window (the documented one-off pg_cron recipe).
   **Do not start here.**

## Re-measure

```sql
SELECT count(*) FILTER (WHERE cache_updated_at < now()-interval '24 hours') AS stale_gt24h,
       count(*) FILTER (WHERE cache_updated_at < now()-interval '48 hours') AS stale_gt48h,
       round(extract(epoch FROM (now()-min(cache_updated_at)))/3600,1) AS oldest_age_h
FROM saved_wallets;
```
The job is display-only and self-healing, so a completed run at any point clears this entirely — the issue is
that no run has completed since 08-13.

# The instance's top consumer fetched 9,613 rows to reject them — and the planner would not take the fix without a fence

**2026-09-01 ~04:10Z · cloud pass, device-linked · SHIPPED**

## What was measured

`refresh_wmc_fmv_drift_active`, found via the newly-scheduled `ops_pgss_delta` over a 2h53m window:

- **1,084,765** `shared_blks_read` over **35** calls = **30,993 blocks (~242 MB) per call**, every ~5 minutes
- ~**8.5 GB** of disk reads every three hours, from one function, on an IOPS-throttled 2 GB instance
- the **number one** line item on the instance, ahead of the audit sessions' own `query_sql` channel

## The defect

The chunk loop led with `(collection_id, edition_key)` via `idx_wmc_coll_ek_serial_cover`, which returns **every holder of an edition across a 2.5M-row table**, and applied the wallet restriction afterwards, as a hash join on already-heap-fetched rows.

But the restriction is tiny and known before the query runs:

| | |
|---|---|
| `allow_list` active wallets | **26** |
| wmc rows owned by them | **202,881** of 2,506,331 = **8.1%** |

One measured 25-edition chunk: **9,625 rows read → 9,613 removed by the join filter → 0 updated.** 64 MB of I/O to update nothing.

## ⚠ The planner will not take the fix on its own

Adding `idx_wmc_wallet_coll_ek_fmv (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd)` is **not sufficient**. Three shapes were measured and the first two were flattened straight back onto the old index:

| shape | wmc buffers | index |
|---|---|---|
| as written (hash join on wallets) | 6,711 | old |
| `CROSS JOIN LATERAL`, no fence | 6,711 | old — **pulled up** |
| `wallet_address = ANY(ARRAY[26 literals])` | 6,711 | old — **post-index Filter** |
| `CROSS JOIN LATERAL` + **`OFFSET 0`** | **2,983** | **new, Index Only Scan** |

The reason is a row estimate: the planner thinks `rows=39` per edition from the old index where the actual is **304–385**, so 650 cheap descents look dearer to it than 25 expensive ones. **`OFFSET 0` is the fence that stops the pull-up.** Remove it and the regression is completely silent — identical rows out, 2.25× the I/O. Same fence, same reason, as `refresh_unmapped_backlog_growth` (`0dcd689`).

👉 **Generalise this:** when a selective restriction lives on a *small* side relation and the big table's index does not lead with it, adding the right index is only half the fix. Check which index the plan actually chose, on buffers, before believing it.

## ⚠ A hypothesis I held and measured FALSE

I expected most **changed** editions to be held by nobody in the allow list, and had designed a cached intersect table to drop them before chunking. **5,581 of 6,206 changed editions (90%) ARE held.** The machinery would have removed 10% of the work and added a cache to keep fresh. Killed before it was built. The waste was never *which* editions were queued — it was *which rows were fetched per edition*.

Also checked and cleared so nobody chases it: the residual **239 heap fetches** on the Index Only Scan are ordinary churn, not autovacuum starvation. `wallet_moments_cache` already carries `autovacuum_vacuum_scale_factor=0.02` and was autovacuumed 45 min and autoanalyzed 5 min before the measurement.

## Result and how to judge it

Query buffers **7,077 → 3,349**. First production call after the change: **15,973 blocks/call vs 30,993** (1.94×) at an unchanged **~15.4 s** — same wall-clock budget, half the I/O.

⛔ **n=1. Two reads are not a rate.** Confirm over ≥20 calls:

```sql
SELECT * FROM public.ops_pgss_delta('2 hours', 50) WHERE q ILIKE '%drift_active%';
```

⛔ **Judge on blocks/call, never wall-clock.** Warm, the new shape is *slower* — 65 ms vs 24 ms — because it pays CPU for 650 index descents. That is the trade being made deliberately on an IOPS-throttled instance. If blocks/call comes back near 30,993, the fence was optimised away or the planner reverted: re-run the EXPLAIN and check which index appears.

**Revert:** `CREATE OR REPLACE` with the pre-2026-09-01 body (only the LOOP's first CTE chain differs), then optionally `DROP INDEX CONCURRENTLY public.idx_wmc_wallet_coll_ek_fmv`.

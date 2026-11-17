> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# The visibility-map class was ranked by the wrong instrument — and following the right one found two pack-sales MVs reading **19× their own table**

**2026-08-29 03:20Z · Cowork cloud pass (continuation) · nothing shipped**

⚠ Scope: no-push is specific to this cloud session; Trevor's box and Claude Code push normally via the
PAT in `remote.origin.pushurl`. No prod state was changed by anything in this filing.

---

## 1. The ranking I handed over was a proxy. Here is the measurement.

The earlier handoff ranked the class by **autovacuum arithmetic** — `n_ins_since_vacuum` against the
default insert trigger. That is an inference about *risk*. The defect itself is directly readable from
`pg_class.relallvisible / relpages`, at zero load. They disagree badly.

| table | **% all-visible** | not-all-visible pages | `n_ins_since_vacuum` | was in "the nine"? |
|---|---:|---:|---:|---|
| `allday_pack_sales_history` | **0.0** | 18,108 | 24 | **no** |
| `topshot_pack_sales_history` | **5.2** | 20,404 | 348 | **no** |
| `offers` | 11.5 | 4,524 | 22,978 | yes |
| `pinnacle_ownership_snapshots` | 18.6 | 3,308 | 41,102 | yes |
| `panini_card_serials` | 31.9 | 12,434 | 568 | **no** |
| `fmv_calibration_caps` | 50.4 | 812 | 3,454 | **no** |
| `cached_listings_v2` | 52.4 | 2,876 | 15,024 | **no** |
| `pinnacle_nft_map` | 54.3 | 371 | 15,577 | **no** |
| `pack_ev_history` | 69.0 | 2,282 | 51,314 | yes |
| `moment_acquisitions` | 73.3 | 7,984 | 76,455 | yes |
| `moments` | 73.8 | 3,611 | 26,404 | yes |
| `pinnacle_mint_events` | 79.6 | 1,937 | 85,523 | yes |
| `pack_ask_hourly_low` | 83.8 | 804 | 29,770 | yes |
| `sales_counterparty_recovered` | **93.1** | 886 | **90,232** | yes — **ranked #1 by the proxy** |

🚨 **The two worst tables in the database are not in the nine at all**, and **`sales_counterparty_recovered`
— which topped the insert-arithmetic ranking at 90,232 inserts — is 93.1% all-visible and needs nothing.**
Shipping the proxy's top item would have been work for no effect.

### Why the proxy missed: the class is UPDATE churn, not insert append

```
allday_pack_sales_history    n_tup_ins        131   n_tup_upd 11,152,245
topshot_pack_sales_history   n_tup_ins      4,146   n_tup_upd 17,112,036
pack_rips                    n_tup_ins     20,869   n_tup_upd    114,542  (n_tup_hot_upd 0)
pack_purchases               n_tup_ins     27,974   n_tup_upd     10,171  <- genuinely insert-dominated
```

⭐ **An `autovacuum_vacuum_insert_threshold` is structurally incapable of helping the top two** — they take
~100 inserts and ~11 million updates. The lever for them is the dead-tuple path
(`autovacuum_vacuum_scale_factor`), and both carry **no reloptions at all**, so the default 0.2 applies:
triggers 110,537 and 117,575 against `n_dead_tup` 78,492 and 84,299 — **71% and 72% of the way**, and
climbing.

✅ **The one thing this does not change is what actually shipped.** `pack_purchases` is 2.7× more inserts
than updates, so the insert threshold was the right lever there — checked, not assumed.

---

## 2. ⛔ AND THEN THE HONEST NEGATIVE: the map is NOT what is costing those two tables anything

I went to vacuum `allday_pack_sales_history` on the strength of 0.0% all-visible. **The plan says don't.**

```
Index Scan using idx_allday_pack_sales_hist_dist  (NOT an Index ONLY Scan)
```

A plain Index Scan never consults the visibility map. **0.0% all-visible is free for this consumer**, and a
VACUUM on that basis would have been a change justified by an instrument the query does not read. Filed
as a negative result so nobody re-derives it: **the all-visible ranking finds candidates; the plan decides.**

---

## 3. ⭐ WHAT THE PLAN FOUND INSTEAD — both pack-sales aggregate MVs read ~19× their own table

Measured `EXPLAIN (ANALYZE, BUFFERS)` on the exact MV bodies, 03:10–03:18Z:

| MV / variant | plan | **buffers** | ms | table pages | amplification |
|---|---|---:|---:|---:|---:|
| `mv_allday_pack_sales_agg` — as it runs | Index Scan + Incremental Sort | **336,247** | 15,826 | 18,109 | **18.6×** |
| `mv_allday_pack_sales_agg` — `enable_indexscan=off` | Seq Scan + Sort | **18,123** (+2,098 temp) | **2,955** | 18,109 | 1.0× |
| `mv_topshot_pack_sales_agg` — as it runs | Index Scan + Incremental Sort | **412,167** | 18,310 | 21,521 | **19.1×** |
| same table, aggregate without `array_agg(ORDER BY)` | Parallel Seq Scan + HashAggregate | **21,521** | 950 | 21,521 | 1.0× |

**The mechanism, and it is the same in both.** `Index Cond: (dist_id IS NOT NULL)` selects **every row in
the table** (552,437 of 552,437; 587,625 of 587,625). The index buys nothing as a filter — the planner
takes it purely for `Presorted Key: dist_id`, to feed the GroupAggregate without a sort, because
`array_agg(sale_price_usd ORDER BY block_time DESC)` demands per-group ordering. It then visits the heap
once per row in index order on an uncorrelated table, re-reading the same pages over and over. That is the
whole 300–400k `shared hit`.

⭐ **The last row is the positive control:** same table, same predicate, only `array_agg(... ORDER BY ...)`
removed → the planner drops the index, and the read collapses from 412,167 buffers to 21,521.

⚠ **Read the buffers, not the timings.** The forced Seq Scan was measured **cold** (`hit=14, read=18,109`)
against an Index Scan running **warm** (304,832 hit) — the comparison is biased *against* the winner and it
still wins 18.6× on buffers and 5.4× on time.

### Why this matters now

| job | schedule | recent durations | ceiling |
|---|---|---|---|
| **jobid 210** `rpc-refresh-allday-pack-sales-agg` | `20 */6` | 13.2 s · 112.6 s · 170.2 s · **581.4 s** · **614.0 s** | **600 s** |
| **jobid 212** `rpc-refresh-topshot-pack-sales-agg` | `50 */6` | 91.9 s · 97.5 s · 179.2 s · 249.7 s · 295.3 s · **326.2 s** | 600 s |

jobid 210 **has already exceeded 600 s once** (614.0 s, 08-27 18:20Z) and ran 581.4 s the next day. The
long runs are all in-band; the short ones are all out-of-band. ⭐ **One lever covers both jobs.**

---

## 4. Two candidate levers — ⛔ NEITHER SHIPPED, deliberately

**(a) Restructure the MV** so `last_sale_price` comes from a separate `DISTINCT ON (dist_id) … ORDER BY
dist_id, block_time DESC` leg, freeing the main aggregate to hash. Semantics-preserving in principle, but
it is a real rewrite of a live board-feeding MV and needs a row-level before/after diff plus a ~600 s
`REFRESH` to verify.

**(b) `ALTER FUNCTION refresh_allday_pack_sales_agg() SET enable_indexscan = off`** — surgical, reversible,
changes no SQL, scoped to that one function. ⚠ **But it also applies to `REFRESH … CONCURRENTLY`'s own
diff machinery**, which uses the MV's unique index. At 1,184 / 1,842 MV rows that is almost certainly
harmless — *almost certainly* is not measured, and it is a planner-wide switch inside a function.

⛔ **Not shipped because nothing is broken right now:** jobid 210 ran **13.2 s** at 00:20Z and jobid 212
**91.9 s** at 00:50Z tonight. This is a *prevent-the-next-breach* fix, not an incident, so it deserves a
verified change in a quiet window rather than a planner hack at 03:00Z in-band. **Trevor's call which
lever; (a) is the durable one, (b) is the cheap one.**

## 5. What is not established

⛔ **The split between the SELECT and the `REFRESH … CONCURRENTLY` machinery.** The MV body measures
15.8 s / 18.3 s at 03:00Z while the refreshes take 581 s / 326 s in-band. Most of that gap is plausibly
the documented 10× band effect, but **I did not measure the refresh itself**, so "cutting buffers 18×
fixes jobid 210" is a prediction, not a result.
⛔ **Whether other consumers depend on `idx_allday_pack_sales_hist_dist` / `idx_ts_pack_sales_hist_dist`.**
Neither lever above drops them, but anyone reaching for "just drop the index" must check first.
⛔ **Steady-state cost of the seq-scan plan under concurrency** — the forced run spilled 16,784 kB to temp
(`work_mem`-dependent), and I measured it once, alone.

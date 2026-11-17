# The Top Shot sales ledger carries ~20,800 duplicate rows inside the live FMV window — and ~4.3 points of the go-live M1 metric rests on them

*Cowork (cloud), 2026-09-08 12:1x PT / 19:1xZ. Found while closing out a session watch: a falsifier I had been reading as "0 all day" returned 2, and the pair it returned was not the one I shipped.*

---

## How it surfaced, which is the only reason it was found at all

The parked-sale lane shipped today came with a duplicate falsifier: *"`source='atlas'` rows with a non-atlas row for the same nft within ±10 min stays 0."* At 19:08Z a **broadened** version of that query — any two rows from *different* sources, not just atlas — read **2** where it had read 0 all day. The pair was `offer_fill` $7.00 vs `onchain` $6.00, 39 s apart, different transaction hashes; Atlas's own record for that nft holds exactly one event, a $6.00 listing purchase. That single pair is still unexplained and is only ~1.7/day (51 such pairs since 08-10), **but widening the same query to the whole 30-day window is what exposed the real thing.**

⭐ **The lesson is the falsifier's shape.** Mine was scoped to the writer I had just added. A duplicate-detection query scoped to your own change cannot see a duplicate between two writers you did not touch — and both of those had been running for months.

## The finding, measured over 45 days

**27,608 cross-source pairs share the SAME `transaction_hash`, the SAME `nft_id` and the SAME `price_usd`.** One on-chain transaction, two rows in `sales`.

| | |
|---|---|
| Cross-source pairs, 45 d | 27,810 |
| …same tx **and** same price | **27,608** (99.3 %) |
| …with a NULL tx on either side | **0** |
| Inside the live 30-day FMV window | **20,780** |
| Editions affected in-window | **5,548** of 9,114 with any sales (61 %) |
| First seen / newest | 2026-07-25 / **2026-08-28 11:31Z** |

The writers are `topshot_gql` on one side and `onchain` or `offer_fill` on the other. They stop dead on **2026-08-28**, the day `public-api.nbatopshot.com` died and the GraphQL ingest went silent — which is exactly why nobody has noticed: **it is not producing new rows, so no alert can fire, and the ~20,800 it already wrote sit quietly inside every 30-day window until 2026-09-27.**

## ⛔ Root cause: a unique key diluted by a timestamp the two writers disagree about

```
CREATE UNIQUE INDEX idx_sales_tx_nft_sold ON public.sales
  USING btree (transaction_hash, nft_id, sold_at) NULLS NOT DISTINCT
  WHERE (transaction_hash IS NOT NULL);
```

The key **contains `sold_at`** — and the two writers date the same transaction differently: `topshot_gql` takes the marketplace's timestamp, the indexer takes block time. Measured `sold_at` delta across the 20,780 in-window pairs:

| delta | pairs |
|---|---|
| exactly 0 ms | **0** |
| < 1 s | 205 |
| 1–60 s (median ~3.4 s) | **20,563** |
| > 60 s | 12 |

**Not one pair collides.** The index was never violated, so `ON CONFLICT DO NOTHING` never fired, and the guard reads as if it is working. ⭐ **A uniqueness constraint that contains a timestamp cannot dedupe two writers who disagree about the timestamp** — and the tell is that the violation count is *exactly* zero rather than small.

## Why it matters now rather than as history

FMV confidence is a **count over a rolling 30-day window** — MEDIUM at ≥ 5 sales, HIGH at ≥ 7 (`lib/fmv-confidence.ts`). A doubled sale is a doubled comp. Recomputing the window with each pair's `topshot_gql` row dropped:

| | now | deduplicated |
|---|---|---|
| Editions ≥ 5 sales / 30 d | 4,868 | **4,270** |
| Editions that fall below MEDIUM | — | **598** |
| Editions that fall below HIGH | — | **624** |

598 of 14,015 editions is **~4.3 points of `topshot_fmv_high_med_share_pct`** — the go-live **M1** metric, which read **50.9 %** against its **50 %** bar at the 13:48Z leg run.

⭐ **So the honest, deduplicated M1 is already below its bar — roughly 46.6 % — and it will get there on its own around 2026-09-27, when 08-28 leaves the 30-day window, whether or not a single row is deleted.** Today's reading is not a measurement of a passing gate; it is a measurement of a window that still contains the duplicates. This also double-weights those prices in any FMV that averages them, and inflates every "sales in the last 30 days" number shown on a moment or edition page.

⚠ It further explains the drift recorded earlier today (53.0 → 50.9 in ten hours, attributed to the recalc sweep re-levelling): **part of that re-levelling is duplicated days ageing out of the window.** Both mechanisms are real; the ledger entry from 19:0xZ named only the first.

## Not fixed here, deliberately

Deleting ~20,800 rows from `sales` is destructive and needs a designed migration, not a wrap-up action:

1. `SET LOCAL rpc.allow_bulk_delete` for the `rpc_delete_guard` circuit-breaker.
2. A row-for-row backup table (`audit_2026xxxx_sales_gql_dupes`) before the delete, with counts asserted against it in the same transaction.
3. An explicit **keep-rule**: keep the **non-`topshot_gql`** row of each pair — the on-chain and offer-fill rows carry `buyer_address`/`seller_address` that the GQL row frequently lacks. ⚠ Verify that per-pair before committing to it rather than assuming it.
4. An FMV recompute over the affected 5,548 editions afterwards, and a re-read of M1 — **expect it to DROP by ~4 points, and expect that to be the honest number.**
5. Consider whether the index should be re-cut as `(transaction_hash, nft_id)` — without `sold_at` — or whether a cross-source twin trigger like All Day's `trg_zzz_allday_cross_source_dedup` should cover Top Shot. Either would have prevented this; both need their blast radius measured first (the index is partitioned across `sales_2020`…`sales_2027`).

## Reproduce

```sql
SELECT count(*) FROM public.sales a
JOIN public.sales b
  ON b.collection_id = a.collection_id AND b.nft_id = a.nft_id
 AND b.transaction_hash = a.transaction_hash AND b.price_usd = a.price_usd
 AND b.id <> a.id AND a.source IS DISTINCT FROM b.source
 AND b.sold_at BETWEEN a.sold_at - interval '10 minutes' AND a.sold_at + interval '10 minutes'
WHERE a.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND a.id < b.id AND a.sold_at > now() - interval '30 days';
```

## Falsifier

Any such pair with `sold_at > 2026-08-28 11:31Z`. There are none today; one would mean a second writer is live again and this is an ACTIVE leak rather than a fixed-size backlog.

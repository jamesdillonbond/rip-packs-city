# `daily-portfolio-snapshot` has missed two days — and three hypotheses are already dead

**Filed 2026-09-19 10:45 AM PT (Cowork cloud). READ-ONLY, nothing shipped.** Surfaced by the
sentinel's `Pipeline Success Coverage` arm, which named it correctly. The dead hypotheses are the
point of this filing: each looked obviously right and each is refuted by a measurement.

## The failure

`snapshot_all_user_portfolios()` writes one `portfolio_snapshots` row per user per day.

| day | runs | ok | rows_written | duration |
|---|---|---|---|---|
| 09-14 | 1 | 1 | 25 | 22.5 s |
| 09-15 | 1 | 1 | 26 | 13.5 s |
| 09-16 | 1 | 1 | 27 | **1.9 s** |
| 09-17 | 1 | 1 | 27 | 11.9 s |
| **09-18** | 1 | **0** | **null** | **120.2 s — `canceling statement due to statement timeout`** |
| **09-19** | 1 | **0** | **null** | **120.2 s — same** |

⚠ **Two days of portfolio history are simply missing for ~27 users**, and `ON CONFLICT DO NOTHING`
on `(owner_key, snapshot_date)` means a later run cannot backfill them — a re-run today writes
today's date, never 09-18's. **The gap is permanent unless someone inserts those rows deliberately.**
(09-12 also failed the same way, so 09-12 is missing too.)

⛔ **NOTE `rows_written = null`, not `0`** — the run died before reporting, so the null is honest
here. Do not read it as "wrote nothing on purpose".

## ⛔ Three hypotheses, all killed by measurement — do not re-run these

1. ⛔ **"07:05Z is a contended window."** **Refuted, and backwards.** Failures per UTC hour over
   72 h: 07:00Z is **3.3 %**, and the 07–11Z band (1.6–3.3 %) is the QUIETEST of the day against a
   12.2 % peak at 12:00Z. The lane already runs in the best slot available; moving it has nowhere
   better to go.
2. ⛔ **"The covering index from register #111 is missing."** **Refuted — it exists.**
   `idx_wmc_wallet_coll_ek_fmv_tier (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd,
   tier)`, 400 MB, is built. So is a better-suited one for this query,
   `idx_wmc_cohort_cover (wallet_address, collection_id) INCLUDE (fmv_usd)`, 322 MB.
3. ⛔ **"`wmc.wallet_address = ANY(uw.wallets)` defeats the planner into a seq scan."** **Refuted
   by EXPLAIN.** The plan is already what you would hand-write:
   ```
   HashAggregate
     -> Nested Loop  (cost=11.68..58170.14 rows=678376)
          -> GroupAggregate on saved_wallets (27 rows)
          -> Index Only Scan using idx_wmc_cohort_cover on wallet_moments_cache
               Index Cond: (wallet_address = ANY ((array_agg(DISTINCT sw.wallet_addr))))
   ```
   No seq scan, index-only, correct join order. **There is no plan fix to make.**

## What it actually is

**Volume plus an incomplete visibility map.** The nested loop passes an estimated **678,376 rows**
— every FMV-bearing moment of every saved wallet, aggregated from scratch daily.
`wallet_moments_cache` is **940 MB heap / 2,212 MB of indexes / 2.2 M rows**, and
`relallvisible` is **97,513 of 120,286 pages = 81 %**. So ~19 % of the index-only scan's rows still
take a heap fetch — on the order of 10⁵ random reads, which is exactly the difference between the
1.9 s run and the 120 s ones.

⭐ **The spread itself is the diagnosis: 1.9 s → 13.5 s → 22.5 s → 120 s for the SAME ~27 rows of
output.** Identical work, an order of magnitude of variance ⇒ **IO-contention-bound, not
statement-bound** — the same conclusion the `atlas_listing_verify_tick` investigation reached
earlier today, on a different lane.

⚠ **Reproduced live at 10:45 AM PT:** the read-only form of this query exceeded the 60 s MCP cap,
so the slowness is current and not an artifact of the 07:05Z runs.

## Candidates, none costed, none obviously right

1. **Raise the VM coverage** (`VACUUM` / a lower `autovacuum_vacuum_scale_factor` on
   `wallet_moments_cache`) so the index-only scan stops fetching heap. ⚠ Measure first: at 81 % the
   headroom is 19 %, which may not be the whole gap, and a vacuum of a 940 MB table with 2.2 GB of
   indexes is itself real IO on a box that is short of it.
2. **Make it incremental.** The function recomputes every user's entire portfolio from zero every
   day. Only wallets whose `wallet_moments_cache` rows changed need re-aggregating.
3. ⛔ **Do NOT just raise the 120 s budget.** The standing rule is to not raise a timeout under
   saturation, and `SET statement_timeout TO '120s'` on this function is load-bearing.
4. ⚠ **Separately, and cheaply: decide whether the missing 09-12/09-18/09-19 rows get backfilled.**
   That is a product call about a history chart, not an engineering one.

## Also seen next to it, and it is NOT the same problem

`golazos-buyer-backfill` fails identically (30 s budget) on 09-18 and 09-19 — but it has written
**0 rows on every single day from 09-05 to 09-19 except 09-15 (1 row)**. It is a near-zero-yield
lane, so its failure costs nothing measurable. ⚠ Worth asking whether it should run at all, which
is the `Zero-Yield Lanes` arm's question, not this one's.

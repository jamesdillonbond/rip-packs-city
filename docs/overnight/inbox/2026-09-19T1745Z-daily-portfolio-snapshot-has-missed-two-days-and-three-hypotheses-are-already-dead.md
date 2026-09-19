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

## What it actually is: 🚨 THIS IS **R109**, AND THIS LANE IS ITS SECOND VICTIM

**Do not investigate this as a new problem.** Register row **R109** (first seen 2026-09-18) already
states it: *"`wallet_moments_cache` cannot hold a clean visibility map, and the cohort rebuild is
the first lane to die of it"*. Same table, **same index** — R109's measurement is taken on
`idx_wmc_cohort_cover`, which is the exact index this query's plan uses. R109 has already refuted
index bloat, a plan flip, and contention, and its standing hypothesis is UPDATE-in-place churn
(wmc is rewritten by `refresh_wmc_fmv_changed`) against long-open snapshots, so vacuum can run
hourly and never get the map clean.

⭐ **The contribution of this filing is therefore NOT a diagnosis — it is that the class has
SPREAD.** R109 called the cohort rebuild "the first lane to die of it"; `daily-portfolio-snapshot`
is the **second**, and it is the one with a user-visible, permanently-lost artifact.

⚠ **AND A CORRECTION TO MY OWN FIRST DRAFT, because it made the error R109 itself is cited for.**
I wrote that `relallvisible` = 97,513/120,286 = **81 %**, therefore "~19 % of rows take a heap
fetch". **That inference is invalid and is the exact trap CLAUDE.md attributes to R109:** an
AGGREGATE is never a proxy for the SLICE you measured. R109's own numbers are **85.8 % all-visible
yet 36.7 % heap fetches** on a real slice — more than double what the aggregate would predict. So
the heap-fetch share for THIS query is **not known** and must be measured on its own slice before
anyone sizes a fix from it.

ℹ One number here IS new and worth carrying to R109: `relallvisible` read **97,513 / 120,286 =
81.1 %** today against R109's **103,213 / 120,286 = 85.8 %** on 09-18. **The map has degraded
further**, which is consistent with R109's churn hypothesis and is a free datapoint for it.

The volume half stands on its own: the nested loop passes an estimated **678,376 rows** — every
FMV-bearing moment of every saved wallet, re-aggregated from zero daily — over a **940 MB heap /
2,212 MB indexed / 2.2 M row** table.

⭐ **The spread itself is the diagnosis: 1.9 s → 13.5 s → 22.5 s → 120 s for the SAME ~27 rows of
output.** Identical work, an order of magnitude of variance ⇒ **IO-contention-bound, not
statement-bound** — the same conclusion the `atlas_listing_verify_tick` investigation reached
earlier today, on a different lane.

⚠ **Reproduced live at 10:45 AM PT:** the read-only form of this query exceeded the 60 s MCP cap,
so the slowness is current and not an artifact of the 07:05Z runs.

## Candidates, none costed, none obviously right

1. ⛔ **"Raise the VM coverage" is R109's question, not this row's, and R109 has already shown the
   knob is not the lever** — its control pair found `wallet_moments_cache` at 85.8 % against
   `topshot_atlas_market_events` at 99.7 % on **the same `autovacuum_vacuum_scale_factor = 0.02`**,
   14× the not-all-visible share. **The autovacuum knob is NOT the difference.** Anything done here
   belongs on R109.
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

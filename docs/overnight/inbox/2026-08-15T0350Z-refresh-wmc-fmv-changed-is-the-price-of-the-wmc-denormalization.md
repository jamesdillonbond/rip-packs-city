# `refresh_wmc_fmv_changed` is the #2 disk reader and it is NOT a defect — it is the price of the `wmc.fmv_usd` denormalization

**Filed** 2026-08-14 20:50 PT (2026-08-15 03:50Z) by Claude Code (interactive), while working down
the `pg_stat_statements` disk-read ranking after fixing the #1 entry. **Read-only. Nothing shipped
against this function**, deliberately — see "Why I stopped".

## The numbers

`pg_stat_statements`, ranked by `shared_blks_read`:

| rank | statement | disk read | calls | mean |
|---|---|---|---|---|
| 1 | `backfill_wmc_fmv_confidence` | 113 GB | 1,488 | 17.6 s |
| **2** | **`refresh_wmc_fmv_changed`** | **112 GB** | **182** | **330 s** |

#1 was a cron-argument defect and is fixed (2:13 → 3.5 s per tick; see the ledger). #2 is not a
defect, which is the point of this note — so nobody spends a session trying to "fix" it.

Live cadence, jobid 303 (`7-57/10`, i.e. every 10 min):

```
2:25 · 1.5s · 2:49 · 1.3s · 4:03 · 1.4s · 2:36 · 2:20 · 2:51 · 51s · 4:52 · 2.1s
```

Roughly half the ticks run **2–5 minutes**, so this holds a connection and a stream of disk reads
for ~25–30% of all wall-clock time.

## The two things it is NOT

⚠ **It is not the temp-table build.** That was the obvious suspect — a `DISTINCT ON` over
`fmv_snapshots` — and measuring it kills the theory. Over a **24-hour** window (far larger than the
10-minute delta it normally sees) it reads **2,568 buffers in 90 ms**, returning 11,423 editions
from 17,322 rows, riding `idx_fmv_snapshots_2026_computed_at_desc`. Negligible.

⚠ **It is not the redundant FMV re-lookup either — even though there genuinely is one.** The temp
table computes `DISTINCT ON (edition_id) … WHERE fmv_usd IS NOT NULL ORDER BY computed_at DESC`,
i.e. it has the winning `fmv_usd` in hand, and then keeps only `(edition_id, computed_at)` — so the
loop re-probes `fmv_snapshots` per edition to get back a value it already had. Carrying `fmv_usd`
into the temp table would delete that probe and is **provably** equivalent (same predicate, same
ordering, same pick). But at ~11,400 editions/day × ~4 buffers that is **~425 MB/day against
~177 GB/day** — **0.24%**. It is not worth a migration and its ~10–20 s of user-facing `PGRST002`
500s. Recorded so the next reader can see it was noticed and priced, not missed.

## What it actually is

The cost is the **UPDATE fan-out**, and it is inherent. `wmc` is the portfolio store: one row per
(wallet, moment). Propagating one edition's new FMV means touching **every row of every wallet
holding that edition**, through `idx_wmc_coll_ek_serial_cover` (384 MB). A popular edition is held
by thousands of wallets. `wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd` avoids the *write* when nothing
changed, but the rows still have to be found.

**So 112 GB is what it costs to keep a denormalized FMV column on a 2.3 GB portfolio table
current.** The lever is the denormalization, not the function.

## Why I stopped

- The obvious micro-optimizations were measured and are worth **0.24%** and **~nothing**
  respectively.
- `v_chunk = 5` looks wrong (2,285 loop iterations for a 24 h backlog) and raising it may well
  help — but the function was **caught up** while I looked (cutoff 2m17s old, 0 rows pending), so
  there was no heavy run to measure against, and this session already has one worked example of an
  "obvious" unmeasured optimization turning out to be a regression (see the `get_pack_detail_bundle`
  correction filed the same day).
- It is a **pricing-adjacent** function on a 5–10 minute cron: a bug here silently writes wrong
  portfolio values, and nothing would page.

## If someone picks this up

1. **Measure during a real backlog**, not a caught-up window — right after the daily `fmv-recalc`
   sweep (~11,400 editions changed in 24 h). Capture `EXPLAIN (ANALYZE, BUFFERS)` of ONE loop
   iteration's UPDATE, which is the part nobody has profiled.
2. **Then** consider, in this order: (a) raise `v_chunk` — the deadline check is per-iteration, so
   a larger chunk still respects the budget as long as one chunk fits; (b) carry `fmv_usd` in the
   temp table; (c) question the denormalization itself.
3. ⚠ **Watch the cutoff feedback loop.** `v_new_cutoff` is `MIN(computed_at)` of what REMAINS in
   the temp table, so a run that hits its deadline advances the cutoff only as far as it drained.
   If the loop can never drain within budget, every subsequent run rebuilds a large window — the
   duty cycle then compounds rather than recovering.

## Related, shipped in the same pass

`idx_wmc_wallet_collection` (72 MB) was **dropped** — 0 scans in 63 days of uninterrupted stats
(`stats_reset` NULL, postmaster up since 2026-06-12) and a strict *prefix* of
`idx_wmc_cohort_cover (wallet_address, collection_id) INCLUDE (fmv_usd)`, so it is redundant
structurally, not merely statistically. Every `wmc` UPDATE — and this function does a great many —
now maintains one fewer index.

⚠ **Eleven more unused indexes >10 MB exist (~311 MB total) and I did NOT sweep them**, because
"unused" and "safe to drop" are different claims. Two examples of why: `idx_sales_*_nullseller_soldat`
is for the seller-recovery backfill that CLAUDE.md records as **INERT pending
`DUNE_SALES_SELLER_QUERY_ID`** — dropping it breaks that job the day it is switched on — and
`idx_sales_2026_fmv_recalc_window` is named for a job that runs constantly, so its 0 scans mean the
planner rejects it, which is a different question from whether it is wanted. Each needs its own
caller check.

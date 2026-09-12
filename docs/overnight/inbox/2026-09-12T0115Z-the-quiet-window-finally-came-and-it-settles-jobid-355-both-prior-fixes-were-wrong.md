# The quiet window finally came, and it settles jobid 355 — BOTH prior proposed fixes were wrong, and the existing index is enough — 2026-09-12T01:15Z

Filed by Claude Code on Trevor's box (interactive, 2026-09-11 18:15 PT). Every filing on this job
today was gated on *"measure BUFFERS outside a spell"* and none could. **At 18:07 PT the instance was
quiet — 1 active backend, 0 IO waiters, 0 startup timeouts in 15 minutes — so the measurement finally
happened.** Same instrument on every variant, one after another, on the same quiet instance.

---

## The result

| window on `t.traded_at` | outer rows | plan | **buffer reads** | writes |
|---|---:|---|---:|---:|
| **unbounded (today)** | 148,025 | Parallel Hash Join | **40,331** | 7,369 |
| 30 days | 33,749 | **serial** Hash Join | **TIMEOUT > 120 s** | — |
| 14 days | 8,119 | **Nested Loop** | **2,443** | 0 |
| 7 days | 1,325 | **Nested Loop** | **372** | 1 |

**A 7-day bound is a 108× reduction in physical reads; 14 days is 16×.**

⭐ **AND THE CURVE IS NOT MONOTONIC — the middle is the worst place to be.** 30 days is *slower than
no bound at all*, and the plan says why: the smaller outer scan drops below the parallel threshold, so
the **same** 58k-row hash over `wallet_moments_cache` runs on **one** worker instead of two. **Bounding
the outer table does not shrink the dominant cost; it only takes away the parallelism that was hiding
it.** A team that tried "30 days" as the obvious first step would have measured a regression and
concluded the lever does not work.

## Both previously proposed fixes are refuted

⛔ **(1) "Cut the `50000` batch" — already refuted** (byte-identical plan at `LIMIT 50000` and
`LIMIT 50`; the estimate is `rows=19`, so the LIMIT is **non-binding**). That was my own action item in
**#84** and it is corrected there.

⛔ **(2) "Add expression indexes on `lower(wallet_address)` / `lower(to_wallet)`" — NOT NEEDED.** The
sibling filing reasoned that a function on both sides forces the planner to "hash one side whole".
**The plan does not do that.** It uses `idx_wmc_collection_id` and hashes only the ~58k Pinnacle rows,
and at 7 or 14 days it switches to a **Nested Loop driven by `idx_wmc_moment_collection_cover`
(`moment_id, collection_id`) — an index that ALREADY EXISTS** — with `lower(...)` demoted to a cheap
per-probe `Filter`. ⭐ **No new index on a 3.26 GB IO-bound table is required**, which is the expensive
thing that prescription would have bought.

## Why the job is 8 s one run and 490 s the next

It re-derives **3,728 candidate rows every run** against an existing set of **3,742** — and
`ON CONFLICT DO NOTHING` discards essentially all of them. **Inserted: 3 rows in 24 h, 6 in 7 days.**
The work is identical every time; only **cache residency** differs. **That is the whole variance.**

## The safety margin, measured rather than assumed

A time bound is only safe if nothing arrives late. Splitting on the obvious change point — the
initial backfill drained **08-23 → 08-30** (up to 1,195 rows/day, lags to **242 days**) — the steady
state from **08-31** onward is **1–3 rows/day with a maximum lag of 1.1 days**, every one under 1.2.

⚠ **Reading the pooled distribution instead would have been wrong:** 65% of all rows show a lag over
100 days, which is the backfill's signature, not ongoing behaviour. **A 14-day window is a 12.7×
margin over the observed steady-state maximum; 7 days is 6.4×.**

## Recommendation — NOT shipped, and the reason is not caution for its own sake

**Add `WHERE t.traded_at > now() - interval '14 days'` to the `candidates` CTE** of
`backfill_pinnacle_trade_acquisitions`. 14 over 7 because the margin matters more than the difference
between 2,443 and 372 reads — both are noise against today's 40,331.

⛔ **It is not shipped because it changes what the system CAPTURES, on a user-facing path.**
`moment_acquisitions` feeds `/api/cost-basis`, `/api/wallet-cost-basis`, `/api/wallet-hold-time` and
`/api/wallet-search`. If a trade's `wallet_moments_cache` row ever appears more than 14 days late, that
acquisition is skipped **permanently** — nothing re-scans it afterwards. Nothing observed does that,
but the observation window is ~12 days of steady state. **That trade-off is Trevor's, and it is a
one-line approval.**

⚠ **If it ships, the revert is the current body** (drop the `WHERE`), and a one-off unbounded manual
run re-catches anything the window ever missed — so the failure mode is recoverable, not permanent,
provided someone remembers this paragraph.

**What is settled regardless:** the batch size is not the lever, expression indexes are not needed,
the existing cover index is sufficient, and the job's cost is a full re-derivation of a set that is
already complete.

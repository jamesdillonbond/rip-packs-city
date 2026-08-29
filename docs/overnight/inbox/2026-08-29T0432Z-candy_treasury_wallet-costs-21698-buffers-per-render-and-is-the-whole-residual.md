# `candy_treasury_wallet` costs **21,698 buffers / 42.8 s** on every render, and it is the entire residual of tonight's candy-board fix

**Filed 2026-08-28 (PT) by Claude Code, autonomous pass.** Follow-on to `20260829003000` (candy boards → `candy_fmv_current`) and `20260829004500` (`candy_scarcity_board` scans wmc once), both shipped earlier tonight. This closes the loop on their exit conditions and identifies the one thing left.

---

## First: what those two migrations actually achieved, checked against Vercel rather than assumed

`refresh-insights-cache` never records a board error as a run failure (0 failed of 230 pre-fix and 0 of 47 post-fix in `pipeline_runs`) — the boards log to `console.error`, so **Vercel runtime errors are the only instrument that can see this at all.** Reading it:

| board | last error event |
|---|---|
| `candy_player_board` | 2026-08-29 **00:02:38Z** |
| `candy_parallel_premium` | 2026-08-29 **00:02:38Z** |
| `candy_offer_spread_board` | 2026-08-29 **00:02:38Z** |
| `candy_deals_board` | 2026-08-29 01:15:19Z |
| `candy_secondary_board` | 2026-08-29 01:15:19Z |
| `candy_scarcity_board` | 2026-08-29 **02:40:19Z** |
| `candy_special_serials_board` | 2026-08-29 **02:40:19Z** |
| `candy_pack_market` | 2026-08-29 **02:40:19Z** |

The FMV-scoping fix landed ~00:22Z. ⭐ **The three boards it touched that were not otherwise slow stop dead at 00:02:38Z and have not fired since.** ✅ Corroborated independently by duration: `refresh-insights-cache` averaged **23,187 ms** over 230 pre-fix runs and **9,307 ms** over 47 post-fix runs, **−60%**.

⚠ **But `candy_scarcity_board` — the one I rewrote for its own cost — still fires, and that is my own migration's FALSIFIER, which said:** *"if it keeps accruing at 140 ms warm, the timeouts are not this query's cost at all but contention on the shared `Promise.all` batch."*

⭐ **The falsifier is right, and the timestamps prove it rather than merely suggesting it: scarcity's last event is at the SAME SECOND (02:40:19Z) as `candy_special_serials_board` and `candy_pack_market` — the two boards I deliberately did NOT fix.** Three boards, one instant, one batch. A board rewritten from 8,424 ms to 114 ms does not independently blow a statement timeout; it was taken down with the batch.

---

## The residual, measured

⭐ **A `pg_get_viewdef` sweep over all 14 `candy%` views is unusually clean:**
- **0** still reference the global `fmv_current` — the 003000 fix is complete.
- **14 of 14** carry `security_invoker=on`.
- **Exactly 2** still reference `candy_treasury_wallet`: **`candy_pack_market` and `candy_special_serials_board`** — precisely the two boards still failing.

`EXPLAIN (ANALYZE, BUFFERS)` on `candy_special_serials_board`, cold: **45,608 ms total, 60,946 buffers.**

```
InitPlan 1
  ->  Subquery Scan on candy_treasury_wallet (actual time=42816.689..42816.692 rows=1)
        Buffers: shared hit=16429 read=5269 dirtied=1415
        ->  GroupAggregate (rows=387)
              ->  Index Only Scan using idx_wmc_candy_holder_cover (rows=25577)
                    Heap Fetches: 7189
```

🚨 **21,698 buffers and 42.8 seconds — 94% of the wall clock — to return ONE wallet address.** The second cost is the per-row `sales` LATERAL at **36,552 buffers**, which probes **all eight `sales` partitions** because it carries no `sold_at` bound to prune on.

## ⛔ Three cheaper fixes considered and each REFUTED by measurement

1. **"Apply the `candy_scarcity_board` recipe."** ⛔ It does not transfer, and this is the second time measuring has said so. Scarcity was already scanning all 25k Candy wmc rows for its per-edition split, so deriving the treasury from that same materialised scan was free (23,082 → **3** buffers). `candy_special_serials_board` does **not** scan those rows — it uses per-edition index probes — so there is nothing to share, and materialising 25k rows purely to find one wallet buys nothing.
2. **"VACUUM — the 7,189 heap fetches are a stale visibility map."** ⛔ Refuted: `wallet_moments_cache` was **autovacuumed at 04:21:51Z, fourteen minutes before this EXPLAIN**, and already carried 25,866 fresh dead tuples. Its `autovacuum_vacuum_scale_factor` is already **0.02** (aggressive; the fleet default arm is 0.2). ⭐ **The rows are not stale-because-neglected, they are perpetually hot**: `refresh_wmc_fmv_changed`, `refresh_wmc_fmv_drift_active` and `backfill_wmc_fmv_confidence` rewrite `fmv_usd`/`fmv_confidence` across the table around the clock, so a slice of any collection's rows is always mid-flight. **No vacuum schedule fixes this.**
3. **"Widen the covering index."** ⛔ An index-only scan still consults the visibility map, so more INCLUDE columns cannot remove a heap fetch caused by recency.

## 👉 The fix that remains is PRECOMPUTATION, and the blast radius is two views

The treasury wallet is **one row that changes rarely** — live top-holder counts measured 2026-08-28 were **2,129 · 1,821 · 741 · 655**, a margin of 308 — yet it is recomputed on every board render, and `refresh-insights-cache` renders every 5 minutes on top of organic edition-page traffic. **That is roughly a quarter-million buffers an hour to answer a question whose answer does not move.**

Proposal: a one-row table (⚠ **a table, not a materialized view** — an MV cannot carry `security_invoker`, and known-issues already records `mv_panini_squeeze` coming back `anon=rxm` after a rebuild on 2026-08-23), UPSERTed by a pg_cron job on a slow cadence, with both views reading it.

⛔ **NOT SHIPPED, and the reasons are stated rather than implied:**
- It is a **new object plus a new schedule**, and `cron.max_running_jobs = 32` against `max_worker_processes = 6` means the scheduler is already starved (audit R29: `job startup timeout` is 67–80% of all pg_cron failures and writes nothing to `pipeline_runs`).
- Grants on a new table must be set and diffed explicitly, which is the exact step the `mv_panini_squeeze` rebuild got wrong.
- ⚠ **A cached treasury wallet is STALE BY CONSTRUCTION**, and `is_treasury` is a user-visible flag on a public board. The margin is 308 today so a one-hour cadence is safe by a wide margin, **but that is a dated sample and the staleness window must be argued from a re-measured margin, not from this number.**
- Four DB changes already shipped tonight; a fifth touching a public pricing surface is not a same-night change.

## ⛔ Not established

- **That fixing the treasury lookup clears the batch.** The `sales` LATERAL is still 36,552 buffers, and this filing does not measure what `candy_special_serials_board` costs with the treasury cost removed. **That is the single measurement to take before building anything.**
- **What `candy_pack_market` costs.** It was not EXPLAINed — it is included here only because it is the other view referencing `candy_treasury_wallet`, and because it fails in the same second.
- **Whether the 8-partition `sales` probe is fixable without changing semantics.** "The most recent sale for this serial, ever" genuinely has no time bound.
- ⚠ **Whether 02:40:19Z is representative.** It is the LAST event, not a rate — a batch that fails once an hour and one that fails every render produce the same `last=` field. **Bucket the events before sizing this.**

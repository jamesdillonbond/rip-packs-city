# Queued — why `rpc-reconcile-saved-wallet-stats` (jobid 259) keeps dying, and what to do instead

Cowork cloud session, 2026-08-10 ~07:00–07:35 PT. **Read-only; nothing applied.** This is step (2) of
the order I filed after the 08-09 budget fix was refuted — *profile the function before touching its
budget again.*

## Status: the fix is refuted, do not re-raise

| | |
|---|---|
| 08-09 13:33Z | failed **120.0s** (pre-fix, global cap) |
| 08-10 13:33Z | failed **300.4s** (post-fix, in-command cap) |

**2 of 2 scheduled attempts, two different budgets, never once succeeded on schedule.** Its only
success ever is my off-schedule one-off at 05:01Z (37.0s, quiet instance), which refreshed 78 of 99
rows. ⛔ **Do not raise it a third time** — on a saturated instance a larger budget buys a longer
worker-slot squat before the same kill.

## What this job actually is — and it is not what the name suggests

`app/api/wallet-backfill-multicollection/route.ts` is the *opportunistic* writer of
`cached_moment_count` / `cached_fmv_usd` / `cached_top_tier` (landed 2026-08-08). Its own comment:

> Best-effort by design, not authoritative: 3 of the 5 children are fire-and-forget and may still be
> walking when this runs … **convergence is guaranteed by the nightly pg_cron reconcile
> `rpc-reconcile-saved-wallet-stats` → `reconcile_all_saved_wallet_stats()`.**

So jobid 259 is the **convergence guarantee for a best-effort writer** — and it has never operated.
Those three fields render on the dashboard, `/profile/<username>`, the collection profile page
(`tierColor(w.cached_top_tier)`), `/share` and the OG card. **Consumers traced and live — none of
this can simply be dropped.**

## Actual severity: real but bounded — the opportunistic writer is covering most of it

`saved_wallets`: **99 rows / 0 never-cached / p50 age 9.4 h / max 33.5 h / 78 fresh within 12 h.**
Newest write **13:32:21Z**, one minute *before* the failed reconcile — i.e. the opportunistic path,
not the backstop.

⚠ **This is materially less alarming than "the convergence guarantee has never run."** For context,
the measurement that justified the 08-08 writer was *41 of 99 rows drifting >5 from wmc, all 21 users
affected*; today it is 21 rows past 12 h. **Not urgent. Do not escalate it as an outage.**

**But the staleness is not random** — it tracks whether a wallet is actively being walked:

| wallet | moments | oldest age |
|---|---|---|
| `0xf77bf547fccf6656` | 43,039 | **1.6 h** |
| `0x8bc1c0249e2ebb3e` | 34,806 | **1.4 h** |
| `0xbd94cade097e50ac` | 19,013 | **1.4 h** |
| `0x8bf951fe6f7918b1` | 14,904 | **33.5 h** |
| `0x4ecf6aaa3a6bfe3a` | 14,204 | **33.5 h** |
| `0xf06746d6d596ba89` | 12,367 | **33.5 h** |

The opportunistic writer only fires for wallets the backfill orchestrator happens to walk. **The
wallets it never walks are exactly the ones only the backstop would fix — and the backstop never
runs.** That is a coverage hole the freshness average hides.

## Cost model — measured, and the loop is not the story

**21 distinct `(user_id, wallet_addr)` pairs**, not 99 (the table is `(user, wallet, collection)`-
grained, so `SELECT DISTINCT` yields 21 iterations).

Planner-only `EXPLAIN` of the inner aggregate for one 1,113-row wallet — total **1,603.92**:

```
GroupAggregate                                        1,603.92
  -> Index Only Scan  idx_wmc_cohort_cover              318.13   count(*) + sum(fmv_usd)  ← NO heap
  SubPlan 1 (per collection group, ×6)                  212.89   top_tier
       -> Sort 185 rows -> Limit 1
       -> Index Scan idx_wmc_lock_wallet_coll                    ← heap fetch for `tier`
```

**`top_tier` is ~80% of the plan, and it is the only thing forcing heap access.** `count(*)` and
`sum(fmv_usd)` are index-only via `idx_wmc_cohort_cover (wallet_address, collection_id) INCLUDE (fmv_usd)`;
`tier` is in no index, so every row must be visited.

Top six saved wallets alone hold **138,333 moments**. Across all 21 the reconcile visits on the order
of **10⁵ heap pages** for `tier` — against a 512 MB `shared_buffers` on a disk-IO-budget-bound
instance. That is the 300 s, and it is IO, not CPU. The repo already measured the same shape:
`refresh_seeded_wallet_stats` on a 152,806-moment wallet reads *247 MB at ~90% cache miss and evicts
roughly half the buffer pool*.

### ⚠ I tested the obvious fix and it is mostly a mirage

Folding the correlated subquery into the aggregate already scanning those rows —
`(array_agg(UPPER(tier) ORDER BY <rank>) FILTER (WHERE tier IS NOT NULL))[1]` — measures
**1,603.92 → 1,273.80, only −21%.**

Because the two costs are **not independent**: removing the subquery forces `tier` into the base
scan, which knocks it off its covering index (318 → 1,243). The heap fetches do not go away, they
move. **"SubPlan is 80% of cost, delete it" would have predicted ~5×; the truth is 1.26×.** Anyone
proposing this fix should quote the measured number, not the subplan share.

## Options, ranked — none shipped

1. **Make it resumable (recommended).** The function is a single transaction, so a
   `statement_timeout` kill **rolls back all 21 wallets** — the same all-or-nothing shape recorded
   for the trust precompute. Converting it to a **PROCEDURE with a per-wallet `COMMIT`** (pg_cron
   supports `CALL`) means the timer **re-arms after each COMMIT**, so it effectively gets the budget
   *per wallet* rather than in total. **This fixes the problem with no budget raise and no added
   squat**, and each run makes progress even if killed.
   ⚠ FUNCTION→PROCEDURE is an object change: **grants reset** — re-`REVOKE … FROM PUBLIC, anon,
   authenticated` and re-`GRANT … TO postgres, service_role` in the same migration. ⚠ It loses the
   jsonb return (`wallets` / `rows_refreshed` / `rows_zeroed` / `elapsed_ms`) — re-home that
   telemetry to `pipeline_runs` rather than dropping it. ⚠ Reconcile becomes non-atomic; for a
   convergence backstop that is an improvement, but say so.
2. **Cover `tier` for an index-only aggregate.** Would take the whole thing to roughly the 318 base
   cost. ⛔ **Weigh against the wmc write-amplification finding closed on 08-09** — INCLUDE columns
   *and* partial-index predicates block HOT exactly like key columns, on a 2.2 M-row table written
   constantly by wallet walks. Only viable if `tier` is proven never-updated-after-insert. **Do not
   do this casually.**
3. **The array_agg fold** — −21%, single statement, no schema change. Real but not sufficient alone;
   worth taking *with* (1), pointless instead of it.

⛔ **Not an option: raising the budget again.** Already refuted twice.

## Also worth noting

`rpc-refresh-unmapped-backlog-growth` (jobid 261) **failed at 120.7 s at 13:29 Z** after five clean
9–34 s runs — its re-probe is complete and it confirms the original concern. Both it and 259 died
inside the same congestion window (`rpc-atlas-pack-ev` 600.1 s + `rpc-allday-nem-from-sales-backfill`
711.4 s spanning 13:25–13:42 Z). ⓘ I tested whether that slot is *structurally* congested and it is
**not** — jobid 215 (`*/30`) has p50 100.1 s / p90 215.6 s and exceeds three minutes only **13 %** of
runs. Unlucky, not systematic; do not "fix" either job by moving its minute on this evidence.

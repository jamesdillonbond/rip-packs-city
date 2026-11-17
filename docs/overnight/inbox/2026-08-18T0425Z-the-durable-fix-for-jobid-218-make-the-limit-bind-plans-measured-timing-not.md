# Candidate — the durable fix for jobid 218: make the `LIMIT` bind. Plans + cardinalities MEASURED; the timing A/B is NOT

**Filed by:** Claude Code (interactive) · 2026-08-17 21:25 PT (2026-08-18 04:25Z) · priority: MEDIUM
**Follows:** `inbox/2026-08-18T0330Z-heavy-cron-collision-pinnacle-backfill-io.md` (whose headline was refuted; see its RE-MEASURED section) and the shipped cadence cut `supabase/migrations/20260818040426_audit_20260817_pinnacle_mint_acquisitions_cadence_cut.sql`.

**Status of the parent item:** the cadence cut (hourly → `*/3`) SHIPPED and holds. It bought 16 of 24 daily full sweeps. It did **not** fix the cause. This file carries the cause, measured, so nobody re-derives it.

---

## ⚠ READ THIS FIRST — what is measured here and what is not

| claim | status |
|---|---|
| table + index sizes, row counts | **MEASURED** (below) |
| current plan shape and why it is wrong | **MEASURED** (`EXPLAIN`) |
| the alternative plan shape | **MEASURED** (`EXPLAIN`) |
| **that the alternative is FASTER** | ⛔ **NOT MEASURED — do not assume it** |

The A/B was attempted and **must be discarded**: both forms exceeded a 150 s budget, but the second run happened as the window closed (**3 IO-wait → 13 IO-wait, 4 active → 16 active** within ~40 min), so the two runs saw different instances. **A difference needs both sides counted by the same instrument** — these were not. Worse, the `EXPLAIN ANALYZE` probes were themselves adding IO to the thing being measured. **Re-run the A/B in a genuinely quiet window, with a no-change control**, before shipping anything below.

---

## The cause (measured)

`backfill_pinnacle_mint_acquisitions(50000)` — its `LIMIT` never binds, so every run is a full sweep. The planner's estimate is the root of it:

```
Merge Anti Join  (rows=1)                       <-- ESTIMATE IS ~1
  -> Parallel Index Scan pinnacle_mint_events_pkey    (rows=247,386)
  -> Index Only Scan idx_moment_acquisitions_nft_id   (rows=877,523)
-> Nested Loop -> Index Scan idx_wmc_moment_collection_cover
```

**The anti-join really emits ~382,000 rows, not 1.** `pinnacle_mint_events` holds **420,139** rows and only **6,372** have a `moment_acquisitions` row (`source='pinnacle_mints'`) — **1.5 %**. So the other **98.5 % survive the anti-join and each one drives a nested-loop index probe into `wallet_moments_cache`**, whose indexes total **1,697 MB**. That is the cost: ~382k random index probes per run, to produce tens of rows.

### Cardinalities (2026-08-17, `pg_class.reltuples` + exact counts where cheap)

| table | rows | heap | indexes |
|---|---:|---:|---:|
| `wallet_moments_cache` | 2,234,845 est | 858 MB | **1,697 MB** |
| `moment_acquisitions` | 873,692 est / 876,327 exact | 220 MB | 324 MB |
| `pinnacle_mint_events` | 388,320 est / 420,139 exact | 73 MB | 28 MB |
| `wmc` rows for Pinnacle | **~54,307** (planner est via `idx_wmc_collection_id`) | | |

⚠ **The Pinnacle wmc slice (~54k) is a 7× smaller driving set than the mint events (388k) — and the join REQUIRES a wmc match, so it is a hard upper bound on the candidate set.** That asymmetry is the lever. Note `count(*)` on `wallet_moments_cache` times out; use the estimate, and see [[count-star-pruning-defeats-liveness-probes]].

## Three candidate fixes, in the order I'd evaluate them

**(a) Force the small side to drive — NO schema change.** Simply reversing the `FROM` order does nothing (the planner reorders to the identical plan — verified). A `WITH held AS MATERIALIZED (...)` on the Pinnacle wmc slice does change it:

```
CTE held -> Index Scan idx_wmc_collection_id            (rows=54,307)
Nested Loop Anti Join
  -> Hash Join   (rows=6)
       -> Seq Scan on pinnacle_mint_events              (73 MB sequential)
       -> Hash on CTE held                              (54,307)
  -> Index Only Scan idx_moment_acquisitions_nft_id     (~6 probes)
```

Trades 382k random probes into a 1,697 MB index for one 73 MB **sequential** scan + a 54k build. On an instance throttled to a **22 MB/s** baseline, sequential is the cheap currency. ⚠ But the `held` scan is an Index Scan, **not** Index-Only — it heap-fetches 54k rows from an 858 MB table, and that is where the estimated cost concentrates (33,045 of 52,714). **This is the reason the A/B is mandatory: the alternative may simply move the cost.**

**(b) Make `held` index-only.** Needs `(collection_id) INCLUDE (moment_id, wallet_address)` or `(collection_id, moment_id) INCLUDE (wallet_address)`. ⚠ Weigh hard before shipping: it is a **15th index on a table already carrying 1,697 MB of them**, on an IO-budget-throttled instance, and the build itself is a large IO event on a hot table (`CREATE INDEX CONCURRENTLY` must be a **standalone `execute_sql`** — `apply_migration` cannot). Check HOT-update impact first — see [[hot-updates-include-and-predicate-columns]] and [[large-index-build-on-hot-table]]. Existing near-misses that do **not** suffice: `idx_wmc_coll_ek_serial_cover` has `collection_id` leading and `INCLUDE (moment_id)` but **no `wallet_address`**; `wallet_moments_cache_wallet_collection_moment_key` has all three columns but `wallet_address` leading.

**(c) Directional checkpoint — forward window + periodic full sweep.** `pinnacle_mint_events` has `block_height` (bigint NOT NULL) and `created_at` (NOT NULL), so a watermark is available. ⛔ **A watermark ALONE is wrong and would silently lose rows**: a mint event is only eligible once `wmc` also carries that moment for that wallet, so a row passed over while wmc lagged would never be revisited. Any watermark design **must keep a periodic (daily/weekly) full sweep** as the backstop. See [[flaky-upstream-needs-directional-checkpoint]].

⚠ **Whatever ships, the acceptance test is `EXPLAIN` showing the LIMIT can bind — not a faster wall-clock on one run.** A single fast run on this instance is a cache artifact; that is exactly how the parent filing got "uncontended cheap (11–18 s)" out of a job whose 7-day mean is 116.8 s.

---

## Closing the parent filing's other open item

✅ **`refresh_pack_grail_metrics_mv` is NOT "API-triggered and opportunistic".** It is a **scheduled hourly job at `:23`**, driven externally (cron-job.org — it is absent from `vercel.json` and from `.github/workflows/`) hitting `app/api/cron/refresh-pack-grail-metrics-mv/route.ts:35`, which calls the `SECURITY DEFINER` RPC doing `REFRESH MATERIALIZED VIEW CONCURRENTLY`. Documented at `docs/reference/packs.md:49`. So it lands in the `:13`–`:34` window **by schedule, every hour** — it is not drifting in. ⚠ This does **not** revive the de-piling fix: staggering is dead on this instance for the reasons in the parent's RE-MEASURED section. It is a correction to the characterization only.

⛔ **"Whether the `*/6` and `*/2` jobs in the band also want nudging" — dead, do not re-file.** Same reason. Overlap tracks a job's own duration, not its start minute.

## Observation, recorded not chased

The spell that closed the measurement window (21:17 PT) was led by `refresh_cross_collection_cohort_step1()` at **452 s** and `backfill_topshot_historical_pack_ev(15)` at **278 s** — the latter being jobid 71's callee, i.e. focus.md Item 1, still the biggest single amplifier and still correctly unshipped pending its pin repoint. ⚠ Per `focus.md` priority 3 this is **not** a new investigation: it is the one known disk-IO root cause. Recorded only so the next quiet-window measurement knows which two jobs to schedule around.

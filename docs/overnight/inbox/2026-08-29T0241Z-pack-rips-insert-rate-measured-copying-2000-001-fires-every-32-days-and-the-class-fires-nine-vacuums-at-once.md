# `pack_rips` insert rate MEASURED: copying `2000 / 0.01` fires every **32 days**, not weekly — and setting the class in one batch fires **nine vacuums at once**

**2026-08-28 19:41 PT (2026-08-29 02:41Z) · Claude Code on Trevor's box · READ-ONLY, nothing shipped**

Closes the one measurement the 2026-08-28 evening Cowork handoff named as blocking Trevor's
decision: *"`pack_rips` is the one to decide soonest … it needs one number this pass did not take:
the measured insert rate, to size a threshold against ~34 s per vacuum on a 756 MB heap. ⛔ Do not
copy `2000 / 0.01` onto it unexamined."*

**It was right to say don't copy it. Copied unexamined, `2000 / 0.01` does not solve the problem.**

---

## The measurement

`pack_rips` has **no index on `created_at`**, so a daily aggregate on insert time would be a
756 MB sequential scan — declined, we are inside the 01:00–19:00Z degraded band. Used `sealed_at`
instead (`idx_pack_rips_collection_time`, Index Only Scan, cost 48k, map 100% all-visible after the
08-28 22:57Z manual vacuum) and **validated it as a proxy first**:

    created_at - sealed_at over 3 days, n = 5,113:  p50 9.9 min · avg 10.8 min · p95 25.3 min

Rows are inserted ~10 minutes after seal, so the `sealed_at` daily distribution **is** the insert
rate. Twenty-one days:

    08-08 1440 · 08-09 1570 · 08-10 1561 · 08-11 1043 · 08-12 1365 · 08-13  858 · 08-14  839
    08-15  632 · 08-16  707 · 08-17  568 · 08-18 1402 · 08-19 2231 · 08-20 2265 · 08-21 1213
    08-22  720 · 08-23  532 · 08-24  690 · 08-25 1505 · 08-26 2025 · 08-27 1653 · 08-28 1307

**≈ 1,200 inserts/day, range 532–2,265.** A distribution, not a snapshot.

ⓘ **Stated rather than implied: this is ONE instrument.** `pg_stat_database.stats_reset` is NULL,
so `n_tup_ins` (20,709) has no known denominator and cannot corroborate it. The 21-day spread and
the validated lag are the whole of the evidence.

## The arithmetic that answers the question

`n_live_tup` = 3,673,296.

| setting | trigger | fires every |
|---|---:|---:|
| current (default insert path — no insert settings) | **735,659** | **613 days** — i.e. never |
| copy `2000 / 0.01` from `sales_2026` | **38,733** | **32.3 days** |
| ⭐ `threshold 8000 / scale_factor 0` | **8,000** | **6.7 days** |

🚨 **32 days is the finding.** The Project's own 08-28 pack_rips note predicts the visibility map
goes stale again *"in about three weeks"* (~21 days). A trigger that fires at 32 days **fires after
the map has already rotted** — it would look like a fix, ship green, and leave the regression intact
until someone re-measured heap fetches. That is the shape this repo calls a plausible mechanism
standing in for a measurement.

## ⭐ WHY it misfires here, which is the part that generalises

`insert_scale_factor` is proportional to **table SIZE**; map staleness is driven by **insert RATE**.
The ratio is what decides whether a size-proportional trigger works:

| table | ins/day | % of table/day |
|---|---:|---:|
| `pack_ask_hourly_low` | 66,156 | 13.2% |
| `pinnacle_fmv_history` | 3,634 | 2.00% |
| `sales_counterparty_recovered` | 13,903 | 1.17% |
| `offers` | 1,653 | 1.07% |
| `moments` | 6,378 | 0.90% |
| `pinnacle_ownership_snapshots` | 3,358 | 0.88% |
| **`pack_rips`** | **~1,200** | **0.033%** |

**`pack_rips` is ~27× slower-growing relative to its size than the next slowest table in the class.**
That is the whole explanation, and it is a rule rather than a special case: **a size-proportional
scale factor is the wrong instrument for a table that is large but slow-growing — set
`insert_scale_factor = 0` and pick the threshold off the measured rate.** Everywhere else in this
class `2000 / 0.01` is well sized (fires every **0.1–2.1 days**), which is why copying it feels safe.

⚠ Rates for the six above are `n_ins_since_vacuum ÷ days since last vacuum` — a single interval, not
a distribution, and mildly circular (the denominator is itself insert-triggered). Good enough to
rank, **not** to quote. Only the `pack_rips` figure is a measured distribution.
⛔ `pack_ev_history`, `pinnacle_mint_events` and `moment_acquisitions` have **never** been
autovacuumed, so they have no denominator at all and no rate is computable for them.

## 🚨 THE OPERATIONAL FINDING THE HANDOFF DID NOT HAVE — do not ship the class as a batch

The handoff declined to batch because a blanket change *"raises autovacuum frequency instance-wide
inside the IO band"*. The real objection is sharper and it is not about frequency.

**Every one of these tables is ALREADY past the proposed trigger.** `sales_counterparty_recovered`
90,232 vs 13,840 · `pinnacle_mint_events` 85,468 vs 6,385 · `moment_acquisitions` 75,952 vs 11,324 ·
`pack_ev_history` 51,187 vs 4,948 · `pinnacle_ownership_snapshots` 41,032 vs 5,826 ·
`pinnacle_fmv_history` 27,942 vs 3,819 · `moments` 26,404 vs 9,093 · `pack_ask_hourly_low` 23,816 vs
6,996 · `offers` 22,938 vs 3,548.

**So setting the threshold does not raise a future frequency — it triggers a vacuum on all nine
within one `autovacuum_naptime` (60 s).** `autovacuum_max_workers = 3`, so three run concurrently
over ~705 MB of heap. Cost throttling is **not** the limiter (`cost_limit 200 / cost_delay 2 ms`
≈ 100k cost units/s ≈ 390 MB/s, far above this instance's 22 MB/s IO floor) — **the vacuums contend
directly for the binding constraint.**

⭐ That immediate vacuum is *desirable* — it is the same one-time map repair that produced the
`pack_purchases` positive control. The hazard is only its **concurrency and timing**.

## 👉 Recommended, NOT shipped (queued for Trevor, per the handoff)

1. **Ship one table per window, in the quiet band (19:00–01:00Z), not as a batch.** The immediate
   vacuum is the repair; serialise it.
2. **`pack_rips` gets `insert_threshold = 8000, insert_scale_factor = 0`** — NOT `2000 / 0.01`.
3. **Verify each the way `pack_purchases` was verified**: `relallvisible/relpages` from outside, and
   `Heap Fetches` on the relevant Index Only Scan before/after.
4. ⛔ **Do not set thresholds on the three never-autovacuumed tables without first asking why they
   have never been autovacuumed** — `last_autovacuum IS NULL` on a table with 75k–85k inserts is not
   explained by the missing insert threshold alone (the dead-tuple path should still have fired at
   some point), and shipping a threshold would paper over whatever that is.

**Revert for any of them:** `ALTER TABLE public.<t> RESET (autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);`

⛔ **Not established:** the per-vacuum cost in steady state. The handoff's ~34 s is a *cold, stale-map*
figure; a weekly vacuum on a warm map skips all-visible pages and, at ~0 dead tuples, skips index
cleanup too (`pack_rips` carries **10 indexes**, so that matters). I did not measure it, and the
recommendation does not depend on it.

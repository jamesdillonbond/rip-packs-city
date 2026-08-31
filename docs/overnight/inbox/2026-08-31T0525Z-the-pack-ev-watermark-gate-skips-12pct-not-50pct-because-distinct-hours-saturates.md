# ⚠ Tonight's pack-EV watermark gate skips **11.8%** of ticks, not the ~50% it was sized for — because `count(DISTINCT date_trunc('hour', …))` **cannot see sub-hourly cadence**

**Filed:** 2026-08-30 ~22:25 PT (2026-08-31 05:25Z) · **By:** Claude Code, Trevor's box, overnight pass
**Class:** instrument blindness → a sizing claim · **Status:** ✅ **CLOSED 2026-08-31** — the recommended action was documentation and it shipped (ledger correction + this filing); the finding was then CONFIRMED on a doubled sample (skip rate 11.8% → 5.9% over 34 ticks). ⛔ Still NOT a revert candidate — see §4. ⓘ One deliberate carry-forward: the function's own body comment still says "~half of all ticks" and should ride along with the next migration that touches it for a real reason (§6.2).
**Subject:** `supabase/migrations/20260830222057_audit_20260830_mv_pack_ev_latest_refresh_watermark_gate.sql`
(shipped ~22:2xZ 08-30 by the cloud session) and its ledger entry.

---

## 1. The claim, and where it came from

The migration's header states the gate's rationale:

> *"Snapshots land **HOURLY** (23 distinct hours in the last 24h) while the refresh runs every 30 minutes,
> so **~half of all refreshes** recompute an identical view."*

and the function body repeats it as a comment:

> *"snapshots land hourly, this job runs every 30 minutes, so **~half of all ticks** take this branch."*

## 2. The gate's own counters refute it

`mv_pack_ev_latest_refresh_state` counts both branches, so this needs no reconstruction:

| | |
|---|---:|
| `refreshed_count` | **15** |
| `skipped_count` | **2** |
| **skip rate** | **11.8%** |

Sized at ~50%. Measured **11.8%** — and n = 17 is small, so the counter alone would not be
decisive. §3 is, and it predicts an even lower steady-state rate than the counters show.

## 3. 🚨 The instrument is the bug: `count(DISTINCT hour)` saturates at 24

The header's evidence — *"23 distinct hours in the last 24h"* — **reproduces exactly**, and that is the
point: it is a true statement that cannot distinguish *once an hour* from *eight times an hour*, because
its maximum possible value is 24 either way. Running both instruments on the same 7 days of
`pack_ev_history`:

| instrument | reading | what it can distinguish |
|---|---:|---|
| `count(DISTINCT date_trunc('hour', …))` over 24 h — **the one used** | **23** | nothing above ~1/hour; saturates |
| distinct `snapshotted_at` over 7 d | **1,407** = **201/day = 8.38/hour** | the actual rate |
| **median gap between consecutive snapshots** | **5.6 min** (p90 **13.1 min**) | the actual cadence |
| **share of gaps under 30 min** (the tick interval) | **96.7%** (1,360 of 1,407) | how often the gate *can* skip |

⭐ **The decisive number is the last one.** The job runs `3,33 * * * *` — every 30 minutes — and
**96.7% of inter-snapshot gaps are shorter than that interval**, with ~4.2 new snapshots landing per
30-minute window. So in steady state the watermark has essentially always advanced by the time the job
ticks, and the skip branch is close to unreachable. The measured 11.8% is if anything *above* what the
gap distribution predicts; the skips are the tail where a gap happened to straddle a tick.

**The premise was never "hourly". It is ~every 5.6 minutes.**

## 4. ⛔ Why this is NOT a revert, stated before anyone reaches for one

The gate costs a **~1 ms index probe** on `idx_pack_ev_history_snapshotted_at_desc` plus one
single-row `UPDATE` per tick. At 11.8% it still avoids a real `REFRESH … CONCURRENTLY` roughly
once in eight ticks, and it is **fail-open** in both directions (NULL history max or NULL watermark
⇒ refresh). Its soundness boundary (append-only `pack_ev_history`) is unchanged and still holds.

**So the gate is a small net win that was booked as a large one.** The defect is in the *claim*, not
the code — and the claim is what a future session would read when deciding whether the pack-EV refresh
cost is "already handled". ⚠ **It is not handled.** The migration opened by naming this job the largest
consumer in its class (810 calls / 70,017 ms mean / 68.6 GB shared reads since the 08-12 reset); the
gate removes ~12% of those calls, not ~50%.

## 5. ⚠ What I deliberately did NOT conclude

Post-gate the job reads **14 runs, 0 failures, avg 13.5 s** against a 7-day pre-gate **335 runs, 21 failed
(6.3%), avg 76.8 s**. That is a 5.7× improvement and **I am not attributing it to the gate**, for three
reasons, each sufficient on its own:

1. **A 11.8% skip rate cannot produce a 5.7× mean improvement.** The arithmetic does not close.
2. **The entire post-gate window is the quiet overnight band**, and the pre-gate window is 7 days
   including known saturation spells. This is the *"a DB A/B must be WARM-vs-WARM"* trap, and the
   *"a rate POOLED ACROSS A FIX"* trap, at the same time.
3. **The same migration also VACUUMed `pack_ev_history` and set autovacuum reloptions** — a second
   change in the same commit, and by its own measurement a large one (probe 2,517 ms → 146 ms). Even
   a real improvement is not attributable between the two arms without a split.

⭐ The honest split is that **§2 and §3 measure the gate's own behaviour directly, through its own
counters and its own input distribution, and need no window matching at all.** That is why they stand
while the runtime claim does not.

## 6. Recommended action — documentation, not code

1. **Correct the ledger** with a new entry rather than an edit to the shipping session's own — that
   file is append-at-top and written concurrently, and rewriting another session's entry is this
   repo's recorded clobber class. ⛔ **Leave the migration FILE alone**: it is the record of what was
   applied, and editing shipped migration text desyncs the repo from the database.
2. **The function's own body comment still says "~half of all ticks"** — the copy a future reader hits
   first, and the one this filing cannot reach. ⛔ **Do NOT raise a migration just to fix a comment:**
   every `apply_migration` costs a ~10–20 s burst of user-facing `PGRST002` 500s (schema-cache
   re-introspection), and it would also force a *third* re-point of the `refresh_mv_pack_ev_latest`
   pin plus a matching edit to the SQL test's verbatim block. 👉 **Ride it along with the next
   migration that touches this function for a real reason** — the correction is worth a free seat,
   not its own trip.
3. ⛔ **Do not re-tune the gate to chase the missing 38%.** Widening it (e.g. skipping unless the
   watermark advanced by more than N minutes) trades freshness on a user-facing pack-EV surface for a
   saving that was never the binding cost, and the binding cost is the refresh itself.
4. **If the pack-EV refresh cost is revisited, start from the fact that ~88% of ticks still do the full
   `REFRESH … CONCURRENTLY`** — the gate did not remove that problem.

## ⭐ The transferable lesson

**A `count(DISTINCT <coarser-bucket>)` is bounded by the number of buckets, so it can only ever prove a
rate is *at most* one-per-bucket — never that it *is*.** Reading 23-of-24 as "hourly" is reading the
instrument's ceiling as a measurement. **When the question is a RATE, measure the GAP DISTRIBUTION, not
the bucket occupancy** — the same shape as this repo's recorded
[[measured-population-equal-to-your-page-size]] (three caches all sitting at exactly 100) and
CLAUDE.md's *"a directional claim needs a DISTRIBUTION, not a snapshot."*

👉 **Cheap general check:** whenever a derived cadence equals or nearly equals the bucket count, the
instrument is saturated and the real rate is unknown and higher.

---

## ✅ CONFIRMED ON A DOUBLED SAMPLE — 2026-08-31 ~07:00 PT (14:00Z)

The gate's own counters, re-read ~8.5 h later:

| | at filing (07:00Z) | now (14:00Z) |
|---|---:|---:|
| `refreshed_count` | 15 | **32** |
| `skipped_count` | 2 | **2** |
| **skip rate** | **11.8%** | **5.9%** |

⭐ **The sample doubled (17 → 34 ticks) and the rate HALVED, moving toward the ~3.3% the gap
distribution predicted rather than away from it.** §2 flagged that n = 17 was too small to be decisive
on its own and that §3's inter-snapshot gaps — median 5.6 min, **96.7% shorter than the job's 30-minute
tick** — implied an even lower steady-state rate than the counters then showed. **It did.** Seventeen
further ticks produced **zero** additional skips.

⚠ Still not a rate to quote as final — it is 34 ticks. But the direction is now confirmed by the
instrument's own counters on an independent second sample, and the headline stands and strengthens:
the gate was sized for ~50% and is delivering **single digits**, so **~94% of ticks still do the full
`REFRESH … CONCURRENTLY`.** ⛔ The recommendation is unchanged: correct the claim, do not widen the gate.

# ⛔ RETRACTION — Top Shot is NOT losing ground. I read a burst as a trend, from two points.

**Filed 2026-08-18T2100Z (13:55 PT) · Cowork cloud · READ-ONLY · corrects `9508ef96`, already on `main`**

## The retraction

`9508ef96` (mine, ~2 h old) concluded **"Top Shot is a FLOW, not a STOCK"** and **"still losing
ground"**, from two counts: 452,789 → 454,316. ⛔ **A third reading refutes it.**

| reading | time (PT) | Top Shot NULL-confidence |
|---|---|---|
| `21ab85ef` (Trevor) | ~11:30 | 452,789 |
| `9508ef96` (mine) | 12:20 | **454,316** ↑ |
| this note | **13:49** | **449,320** ↓ |

**Net −3,469 from the original baseline.** The drain is winning. **My +1,527 was a burst that my
measurement window happened to straddle** — two points, an unknown interval, and I called it a
direction. That is the rule I quoted at Trevor one message earlier: *a directional claim needs a
distribution, not a snapshot.*

## What the inflow actually is — measured, not inferred

The `9508ef96` entry inferred **~5,000/hr** inflow from the rise. Measured directly off `created_at`
on the same predicate:

| window | new NULL-confidence Top Shot rows |
|---|---|
| last 1 h | **0** |
| last 6 h | 58 |
| last 24 h | **10,710** |

**~446/hr on average, zero in the last hour, and bursty.** ⛔ **My inferred 5,000/hr was wrong by an
order of magnitude, and it was wrong because it was derived from the very reading that was itself a
burst artifact.** Do not quote it; it is retracted with the conclusion it supported.

**Oldest NULL row: `2026-04-05`.** This is a **4.5-month accumulated STOCK**, not a steady-state flow.
The framing was backwards.

## What stands, and is now better supported

✅ **The rotation fix works for Top Shot too**, not only All Day. Both are draining.

✅ **Top Shot's backlog is fully convertible — the Pinnacle problem does not apply to it.** Sampling
the head the backfill actually selects: **1,000 of 1,000 rows have a matching `editions` row**, both
on `external_id` alone and correctly scoped by `collection_id`. Contrast the recorded Pinnacle head:
**6 of 1,000**. Top Shot's head is concentrated — **24 distinct `edition_key`s across 1,000 rows**,
~42 wallet rows per edition — which is why a 1,000-row tick clears real ground.

✅ **The inflow is structural and permanent, and that part of the note was right.** Neither writer sets
confidence: `upsert_wallet_moments` and `upsert_wmc_batch` **never mention `fmv_confidence`**, the
column has **no default**, and the table's only triggers are `normalize_tier` and the two
destructive-op guards. **Rows enter NULL by construction**, so the backfill is a permanent converter
with no terminal state — *but at ~446/hr it is far below the drain, so the stock still clears.*

⚠ **Projection, INFERRED:** ~3,000/hr drain (1,000 rows × ~a quarter of 12 ticks/hr) against ~446/hr
inflow ⇒ ~449k clears in **~7 days**. Every term but the two counts is an assumption, and long ticks
eat rotation slots (the 11:27 tick ran 370 s and swallowed 11:32). **Do not quote the ETA** — the
honest claim is *"draining, and convertible."*

## The lesson, on myself

⚠ **I documented "a directional claim needs a distribution" and then published a direction from two
points in the same session.** The tell was available and I skipped it: **the interval between the two
readings was unknown to me** — I did not know when Trevor's count was taken. **A delta across an
unknown interval is not a rate, and it is not even a sign.** A third reading cost one query.

💡 **And the cheap instrument existed the whole time.** `created_at` on the same predicate answers
"is there inflow, and how much" directly, with no differencing and no interval assumption. **When a
stock looks like it is moving, measure the flow, not the difference between two stocks.**

**No changes made.** Read-only; no DB, migration, cron or code change.

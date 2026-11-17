# The unmapped-sales "drain has STALLED" test fires 46% of the time on a working drain — and the obvious retune measures WORSE

**Filed 2026-09-05 ~11:25Z (04:25 PT) — Cowork, cloud, autonomous night pass.**
**Nothing shipped.** The naive fix was measured and is **worse than what is there**; the real fix
needs a decision about what "stalled" means for a **batch** process, which is not a tuning call.

## What the arm claims

`get_pipeline_alerts()` currently renders, for `unmapped-sales-nfl_all_day`:

> *"NO ETA: the drain has STALLED — 0 rows resolved in the last 3h against 37/24h, so the 24h rate
> is stale and an ETA divided by it would be wrong."*

That string is gated by `drain_stalled` in `refresh_unmapped_backlog_growth()`:

```sql
(p.outflow_3h * 16 < p.outflow_24h) AS drain_stalled
```

and it also **suppresses the ETA** — `days_to_drain` is computed only `WHEN NOT (outflow_3h * 16 < outflow_24h)`.

⭐ **The function states its own premise, honestly, in a comment** — which is the only reason this
was checkable at all:

> *"Steady state puts an eighth of the 24h outflow in any 3h window, so `outflow_3h * 16 <
> outflow_24h` says the CURRENT rate is below HALF the 24h average."*

## The premise is false for this drain, and the drain is not steady

Measured over the span this collection has actually been resolving — `resolved_at` from
**2026-08-29 12:01Z** to now, **157 hours, 5,581 rows resolved**:

- **134 of ~157 hours are active** — but the work arrives in **batches**, not a stream.
- **Busiest single hour: 542 rows.** Median gap between consecutive resolutions: **0.00 h**
  (they land in bulk within the same second); **p99 gap 0.75 h; max gap 6.00 h**.
- A 3-hour window reads **zero** in **3.8%** of hours; 6h and 12h windows read zero in **0.0%**.

⚠ **A single 542-row burst inflates `outflow_24h` for the next 24 hours.** Every quiet hour after a
burst therefore reads "the current rate is below half the 24h average" — **which is true, and is
not a stall.** It is what a batch process looks like between batches.

## How often it fires — and the retune that makes it worse

Every hour of the 144 evaluable hours (span minus a 24h warm-up), each predicate evaluated against
that hour's own trailing windows, restricted to hours where `outflow_24h > 0`:

| predicate | fires | rate |
|---|---|---|
| **`outflow_3h * 16 < outflow_24h`** (what ships today) | 66 / 144 | **45.8%** |
| `outflow_6h * 8 < outflow_24h` | 50 / 144 | 34.7% |
| `outflow_12h * 2 < outflow_24h` | 87 / 144 | **60.4%** |

🚨 **The arm declares the drain STALLED in nearly half of all hours in which it resolved 5,581 rows.**

⛔ **And the obvious fix — widen the window — is REFUTED.** I went in expecting `12h × 2` to be the
answer (a 12h window reads zero 0.0% of the time, so it looked safe). **It fires 60.4%, worse than
the 3h test it would replace.** The reason is the same burstiness: a longer window is *more* likely
to straddle a burst that the trailing 24h still carries, not less.

⭐ **That is the transferable part.** *"The window is too short"* was the intuitive diagnosis and it
was wrong. **No ratio-of-current-rate-to-24h-average test can work on a process whose work arrives
in large discrete batches**, because the denominator carries a batch that the numerator has already
passed. Re-tuning the window moves the false-positive rate around between 35% and 60%; it does not
fix the shape.

## What a correct test would need — stated as a decision, not a patch

Any of these is defensible, and **choosing between them is a design call, not a tuning call**:

1. **Quiet-time against its own observed maximum.** "No resolution for longer than N hours", with N
   sized off the measured max quiet period (**6.00 h** here) plus headroom. Immune to burstiness
   because it never divides by a rate. Would have fired **0 times** in 157 hours at N = 12.
2. **Compare batch-to-batch, not hour-to-hour** — has the *count of active hours* per day dropped.
3. **Drop the stall test and always publish the ETA**, with the 24h rate labelled as a trailing
   average. ⭐ Worth considering seriously: the ETA suppression is the actual cost here, and an ETA
   from a trailing average on a backlog whose oldest open sale is **2025-12-29** does not need to be
   precise to be more useful than "NO ETA".

## Scope and what is NOT claimed

- ⚠ **The false-positive framing assumes the drain was healthy across all 144 hours.** That is
  *supported* — 5,581 rows resolved, and `unmapped_resolution_backlog_max` fell **172 → 148** between
  09-04 and tonight — but it is **not proven hour by hour**, and some of those 66 firings may have
  caught something real. The rate is an upper bound on correctness, not a proof of 66 false alarms.
- Measured on **`nfl_all_day` only**, the collection the alert names. A steadier collection may be
  served fine by the current predicate — this is not an argument to change the arm for everyone.
- Severity is **`info`** and nothing is paged. The cost is a scary, specific, and usually wrong
  sentence in a report, plus a suppressed ETA — the same alert-fatigue class as tonight's 403 arm,
  one severity band down.
- ⛔ **Do not "fix" this by flipping the multiplier or the window without re-running the table above.**
  Two of the three candidates I tested were worse than shipping nothing.

## Falsifier

Re-run the predicate table over a fresh span. If `outflow_3h * 16 < outflow_24h` comes back under
~10%, the burstiness measured here was a property of this week's backfill activity and not of the
drain, and this filing over-generalises from one span.

# The sentinel's wall budget starves the END of its arm list, systematically

**Filed 2026-09-19 10:55 AM PT (Cowork cloud). READ-ONLY.** Found while answering "what alerts is
the sentinel sending out". The clamp fix shipped today is a different defect in the same route.

## The measurement

Arms are evaluated in a fixed source order inside one sweep, under a **140 s query budget inside a
180 s wall**. Over 53 sweeps / 48 h, refusals attributed to `aborted: sentinel wall budget spent`:

| arm (source order, late → early) | findings 48h | refused by the wall |
|---|---|---|
| `Ops Probe Cost` | 22 | **22 — every single one** |
| `pg_net Dispatch` | 53 | **22** |
| `Wall Kills (24h)` | 51 | **17** |
| `Cadence Collapse` | 41 | 5 |
| `Zero-Yield Lanes` | 53 | 3 |
| `Alert Delivery` | 35 | 3 |
| **every arm earlier in the list** | — | **0** |

⭐ **That is a monotonic gradient by POSITION, not by cost.** The arms at the end of the list are
the ones that go dark, and they go dark **precisely when the box is slow — which is the condition
they exist to report.** `Ops Probe Cost` has never once produced a reading in a sweep where it was
reached late; it is the arm that measures the sentinel's own probe cost, so the instrument watching
the watcher is the first thing the watcher drops.

Supporting numbers from the same window: average sweep **99.9 s**, max **176.4 s** against the
180 s wall; **0 of 53 sweeps reported ALL CLEAR**; 652 findings total, of which **221 (33.9 %) are
`INCONCLUSIVE (db saturated)`** rather than a measurement.

⚠ **`Measurement Blackout` already exists and already fires on this** ("7 of 25 checks could not be
evaluated (threshold 9) … 3 of them were REFUSED by the sentinel's own wall budget — the arms
before them had already spent the sweep's time, so the sweep was starved, not merely slow").
**The arm is honest and correct. What is missing is that nothing acts on it**, and the position
gradient above is not visible from any single sweep's text — it only appears across runs.

## Why this is not simply "the database is slow"

It is *also* that, and the IO work is the deeper fix. But two things are true independently:

1. **Order is arbitrary with respect to importance.** Nothing makes `Ops Probe Cost` less worth
   knowing than `Sales Ingest (2h)`; it is just declared later in one file. A slow sweep therefore
   drops arms by an accident of source layout.
2. **The loss is invisible in the aggregate.** A reader seeing "WARN, 12 findings" cannot tell that
   three arms were never evaluated unless they read `Measurement Blackout`'s own text.

## Candidates, none costed

1. **Evaluate the cheap arms first, or the historically-starved ones first**, so a starved sweep
   loses its least informative reads rather than its last-declared ones. ⚠ Ordering is currently
   load-bearing in at least one place — the ack pass "must stay AHEAD of the Measurement Blackout
   arm" because that arm counts warns — so this is not a free shuffle; read those comments first.
2. **Rotate the tail**: alternate which of the late arms runs on odd/even sweeps so each gets a
   reading every ~2 h instead of one class never getting one.
3. **Give the starved arms their own sweep** on a separate schedule, outside the 180 s wall.
4. ⛔ **Do NOT just raise the wall.** The 180 s bound exists because the sweep is itself load on a
   saturated box, and `Ops Probe Cost` is the arm that measures exactly that cost.

🔬 **Falsifier for any of these:** re-run the position/refusal table above over a fresh 48 h. If
`Ops Probe Cost`'s refusal share has fallen while total sweep duration is unchanged, the reorder
worked; if sweep duration fell too, the box got quieter and the change is unproven — **split on the
change point, do not pool across it.**

# `fmv-recalc` re-breached ~4 h after being marked CLOSED, and current saturation does not explain it

Filed 2026-08-16 21:50 PT / 2026-08-17 04:50Z (Claude Code, interactive). **OBSERVATION — nothing shipped.** Raised because CLAUDE.md currently records this item as **"VERIFIED in production … this item is CLOSED"**, and a reader arriving at that line will not expect the state below.

⚠ **This filing deliberately does NOT re-assert the "deterministic page poison" claim.** That claim was made on 2026-08-16 20:15Z and **retracted the same day** as a selection artifact — `pipeline_runs` records only `fmv-recalc`'s fast-fail exits, so a 21/21 read off it is a filtered subset, not a rate. Every rate below is computed against the **`fmv-recalc-heartbeat`** denominator, which is the correction that resolved it.

## The state

The 23:40Z verification was real — the cursor marched 6000 → 10500, then wrapped cleanly:

| run (UTC) | cursor | rows | result |
|---|---|---|---|
| 23:48 | 10500 → 11000 | 494 | ok |
| 23:55 | 11000 → 11500 | 490 | ok |
| 00:08 | 11500 → **null** | 2 | ok — **sweep completed, cycle wrapped** |
| 00:15 | 0 → 500 | 1,638 | ok — new cycle |
| 00:28 → 01:08 | 500 → 2500 | ~500 each | ok |
| **01:28** | **2500 → 2500** | 0 | **FAIL** `sales_refetch_failed: 1 chunk fetch errors (saturation-class)` |
| **03:48** | **2500 → 2500** | 0 | **FAIL** — same error |

**The cursor has not advanced since 01:08Z.** `fmv_sweep_wedge_hours` = **3.65** against `breach_at` 3.

## Since 01:28Z, measured off the heartbeat

| | |
|---|---|
| invocations (heartbeat rows) | **23** |
| terminal rows written | **2** |
| successes | **0** |
| killed with no terminal row | **21 (91%)** |

⚠ **91% is materially worse than the ~32% the retraction established and the ~53–65% CLAUDE.md records** — so this is not the documented steady state.

## Saturation does not account for it *right now*

Measured in the same minute: **36 connections, 2 IO waits, 3 active**, and platform-wide **10 failures / 196 runs = 5.1%** over the trailing 30 minutes. That is an ordinary-to-quiet window for this instance, and `fmv-recalc` is at 0% success inside it.

⚠ **I am reporting that as an observation, not a mechanism.** The earlier session's mistake was reading the route's own `(saturation-class)` self-label as a measurement, and the correction's mistake was inferring determinism from a filtered subset. Two failed diagnoses on this exact pipeline in one day is reason to state only what is measured: **the sweep is wedged at cursor 2500, and the platform is not currently under load.**

## What is and is not at risk

⚠ **This is a COVERAGE outage, not an FMV outage** — the phrasing the retraction settled on, and it still holds. The **previous cycle completed at 00:08Z**, so every edition carries a snapshot from then; what is stalled is the *new* cycle's progress past page 2500. Nothing is unpriced, prices are ageing.

## The next useful checks (not run)

1. **Is it page-specific or time-specific?** The cursor is pinned at one page, and the single-chunk structure means `IN_CHUNK == DEFAULT_LIMIT == 500`, so *"1 chunk fetch errors"* means **the only chunk**. Whether page 2500 specifically fails is answerable by fetching that page's sales slice directly — and is exactly the claim that must NOT be assumed, since it has already been asserted and retracted once.
2. **Does the step-1 retry actually cover this call?** The retry shipped for this class defaults to ~250 ms of backoff, which CLAUDE.md notes is "sized for a page render a human waits on" and can land entirely inside a spell. A wedge that survives 21 consecutive invocations is not obviously a transient the current backoff can absorb.
3. **Does it self-clear?** It did once before — `fmv_sweep_wedge_hours` went 12.17 → 0.09 unaided. **Re-read the arm before opening an investigation.**

⛔ **Do not "fix" this by raising `maxDuration`** — it is already at the 800 s Pro ceiling per the standing note, and a longer run holds a pooled connection longer on the instance whose saturation is the suspected trigger.

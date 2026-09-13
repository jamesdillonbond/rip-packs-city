# `reconcile-saved-wallet-stats` reports `ok = false` for its HEALTHY path — 41 of 41 "failures" are one benign string — but the alarm case for fixing it is REFUTED, and that is the useful half

*Claude Code (cloud), 2026-09-13 01:5x PT / 09:00Z. **READ-ONLY. Nothing shipped, deliberately — I was ~one step from a three-file change to a drift-pinned PROCEDURE on the strength of an alert I had inferred and never checked.***

---

## 1. The defect is real and is this repo's own named class

`reconcile_all_saved_wallet_stats` is a resumable, per-wallet-COMMITting sweep with a soft deadline. When it runs out of budget it **commits its partial work and stops**, which is the design. It then logs:

```sql
p_ok    := NOT v_truncated,
p_error := CASE WHEN v_truncated
                THEN 'soft_deadline_reached_partial_sweep_committed' ELSE NULL END
```

**So the healthy path reports a failure.** Measured over the full retained window (75 runs since 2026-09-10):

| | |
|---|---|
| runs | 75 |
| `ok = false` | **41 (55 %)** |
| of those, `soft_deadline_reached_partial_sweep_committed` | **41 — 100 %** |
| any other error string, ever | **0** |
| truncated runs that made progress | **38 of 41** (avg 1.9 wallets, max 15) |
| truncated runs with ZERO progress | **3** |

⭐ **CLAUDE.md names this exact shape — *"`ok = false` is overloaded the same way"* as `rows_written = 0`.** The serious consequence is not the 55 %: it is that **a genuine error on this lane would be one unfamiliar string among 41 identical benign ones**, and nobody reads a list that is 100 % noise.

⭐ **There is a clean fix and it is one expression:** `ok` should be false only for `v_truncated AND v_wallets = 0` — truncating having achieved *nothing* is a real failure; truncating having committed 15 wallets is progress. That takes the lane from **41 failures to 3** over 7 days and the 3 are the ones worth reading.

## 2. ⛔ THE REFUTATION — the reason I did not ship it

I built a justification and then tested it, in this order, and it did not survive:

1. The watchlist arms this lane at **`max_minutes_without_success = 360`** (6 h), `severity: medium`, `is_active`.
2. The longest consecutive `ok = false` streak in the window is **16 runs spanning 16.2 hours**, with **6 distinct streaks in 7 days**. On the face of it that is a ~10-hour false amber, several times a week.
3. ⛔ **It has never fired.** `max_minutes_without_success` is consumed by the **sentinel route** (the opt-in no-success arm added 2026-09-04), and across **all 8 sentinel runs in the last 73 h the lane is not named once** — `extra::text LIKE '%reconcile-saved-wallet-stats%'` is **false** on every one. Positive control: those same runs carry 7–9 warns each, and `get_pipeline_alerts()` currently returns **13** alerts across 5 types, so both instruments demonstrably speak.

**Why it does not fire is NOT established** — candidates are that the arm measures last-success over a window the streak does not exhaust, that `pipeline_runs` ~73 h retention truncates what the arm can see, or that its population differs from my streak query. ⚠ **That gap is itself worth someone's attention**: either the arm is correctly tolerant, or it is structurally unable to see a 16-hour no-success streak on a lane it is armed for — and those two have opposite implications for every other lane on that watchlist.

## 3. ⚠ AND THE CURRENT BEHAVIOUR IS LOAD-BEARING SOMEWHERE ELSE

`app/api/sentinel/route.ts` already compensates, deliberately and with its own measurement:

> *"zero-successes alone produced 4 false positives in 20 days, every one a pipeline degrading gracefully BY DESIGN: `reconcile-saved-wallet-stats` reports ok=false on a soft-deadline partial sweep whose work is committed … Adding the rows_written guard removed 4 of 4 of those and kept 5 of 5 genuine outages."*

So the zero-successes-AND-zero-rows arm was **calibrated against 20 days of history containing these rows**. Fixing the procedure would not break that arm (it would get quieter), but it **would make that comment's stated rationale stale**, and `candy-offers-indexer` is named in the same breath as having the same shape — so the fix wants to cover both or say why not.

## 4. Disposition

⛔ **Not shipped.** The defect is real, the fix is small, and the *urgency* rests on an alarm that measurement says does not fire. A three-file change to a drift-pinned PROCEDURE — migration + verbatim pin + the guard's `migration:` registration — with an inverted assertion in a test that needs its own throwaway database, is not something to do at 2 a.m. on a justification that just collapsed.

**For whoever picks it up, in order:**

1. **Settle §2 first** — why did a 16.2 h no-success streak not reach the sentinel's no-success arm? That answer decides whether this is a cosmetic wart or a hole in an arm that 136 watchlist rows rely on.
2. Then the one-expression fix (`ok := NOT (v_truncated AND v_wallets = 0)`), covering `candy-offers-indexer` too if it shares the shape.
3. Update the sentinel's calibration comment in the same commit — its "4 false positives" arithmetic is the record of why that arm looks the way it does.

⭐ **PROMOTE, because it nearly cost an hour tonight: an alarm you have not seen fire is a HYPOTHESIS, not a justification.** The watchlist row, the threshold and the streak length were all real and all pointed the same way; the alert still never happened. Check the instrument's own output before spending anything on the strength of it.

# The missing All Day offer-fill lane, COSTED against M2's bar: **+1.1 to +2.7 points**, not the fix — and the already-MEDIUM check is what cut it by two thirds

**2026-09-12T06:10Z (2026-09-11 23:10 PT) · Claude Code (cloud), autonomous session · instance quiet at every measurement.**

The `2026-09-11T10:30Z` filing established, against Dune, that All Day is missing **an entire sale type** — accepted OffersV2 fills, ~1,110 over 08-25→09-10, **~24 % of true volume** — and named widening that lane as its *"highest-value item"*, explicitly deferring the sizing: *"How much M2 moves depends on how those fills distribute across editions and how many sit near a threshold — that is measurable and has not been measured."*

**It is measured here, and the answer is materially smaller than it looks.** go-live-2026-09.md's own standard for any M2 proposal is to check it against **6 · 91 · +1.5 pt** before costing it. This one clears that bar as the largest single code-side lever yet measured, and still does not close the gate on its own.

## The estimator: Top Shot is the same contract, so it is an EMPIRICAL analogue, not a model

Top Shot **has** this lane (`source = 'offer_fill'`, **16,524 of 89,488 sales in 30 d = 18.5 %**), from the **same** OffersV2 contract `0xb8ea91944fd51c43` that already serves All Day. So instead of assuming how fills distribute, I can **measure what they did** to Top Shot's volume tiers — concentration included, because a crossing count already accounts for it.

Per Top Shot edition, 30-day window: `n_all` = all sales, `n_ex` = sales excluding `offer_fill`. The **conditional crossing rate to the ≥5 MEDIUM volume floor**:

| sales WITHOUT the lane | editions | crossed to ≥5 with it | crossing rate |
|---:|---:|---:|---:|
| 1 | 1,902 | 193 | **10.1 %** |
| 2 | 1,017 | 220 | **21.6 %** |
| 3 | 646 | 214 | **33.1 %** |
| 4 | 496 | 199 | **40.1 %** |

⭐ **Aggregate: 897 of Top Shot's 4,747 editions at the floor (18.9 %) would fall below it if the lane were removed** — and 607 of 3,624 would fall below the ≥7 HIGH floor, 1,396 of 6,388 below the ≥3 ask-corroboration floor. The lane is load-bearing where it exists.

## 🚨 All Day's headroom, and the check that cut the estimate by two thirds

All Day editions by 30-day sales count — **and how many are ALREADY HIGH/MEDIUM**, which is the number that decides whether a crossing changes anything:

| 30 d sales | editions | already HIGH/MED | **not yet** |
|---:|---:|---:|---:|
| 1 | 850 | 281 | **569** |
| 2 | 478 | 275 | **203** |
| 3 | 338 | **216** | **122** |
| 4 | 215 | **149** | **66** |

⛔ **At 3–4 sales, 365 of 553 editions are already HIGH/MEDIUM** — lifted by ask-corroboration (which fires at ≥3) or by `fmv-recalc`'s 90-day widening for thin editions. **A naive sizing over the 553 would have produced ~198 crossings and +3.2 points.** Over the 188 that are *not* already there it produces **66**, and **+1.1 points**. ⭐ **That is this estate's own "an ELIGIBILITY count is not a GAIN count" rule, and it is the third time it has bitten on this exact metric** (the 09-09 lever: 173 eligible → 54 real → +0.9 pt).

**Sizing, applying the Top Shot crossing rates to the not-yet-HIGH/MEDIUM cohorts:**

| cohort | not yet HIGH/MED | × TS rate | editions gained |
|---|---:|---:|---:|
| at 4 sales | 66 | 40.1 % | **26** |
| at 3 sales | 122 | 33.1 % | **40** |
| **tight total (3–4)** | | | **66 → +1.1 pt** |
| at 2 sales | 203 | 21.6 % | 44 |
| at 1 sale | 569 | 10.1 % | 57 |
| **wide total (1–4)** | | | **167 → +2.7 pt** |

Denominator is M2's own **6,190** (latest `fmv_snapshots` row per `(collection_id, edition_id)` for All Day — the definition `rpc_thp_leg_fmv_coverage` uses, verified by reading its source, and my hand-derivation reproduces its bucket counts exactly: 1,722 MEDIUM · 1,488 ASK_ONLY · 1,291 LOW · 848 NO_DATA · 716 STALE · 119 HIGH · 6 SALES_ONLY = 6,190).

## Verdict against the gate

✅ **Real, and the largest single code-side M2 lever measured so far** — against the doc's recorded levers: complete-the-sweep **+0.1 pt**, confidence-rule tuning **~+1.5 pt**, widen the corroboration window **+0.9 pt**. ⛔ **And still not sufficient alone.** From a 25.8–29.7 % cursor band, +1.1 to +2.7 points makes the 30 % bar *reachable in combination*, not *met*.

⚠ **THE LATENCY MATTERS AS MUCH AS THE SIZE, and it changes which step is the valuable one.** M2 reads a **30-day** sales window, so a forward-only lane delivers this gain **only after ~30 days of running**. The same gain arrives **immediately** from a 30-day backfill of the fills. ⛔ **That backfill is a bulk write to `sales` and remains Trevor's call** (the 10:30Z filing says so, same class as #83) — but it is now clear that **the backfill, not the forward lane, is what moves the gate this month.**

⚠ **Transfer assumption, stated so it can be refuted: that All Day's offer fills distribute across its editions like Top Shot's do.** Supporting it: the same contract, the same sale type, and a comparable relative volume (TS `offer_fill` = 18.5 % of 30 d sales; All Day's missing fills ≈ 24 % of true volume per the Dune measurement). **Refutation test:** once the lane runs for a week, recompute the crossing rates on All Day's own `offer_fill` rows. If they come in materially below 10/22/33/40 %, this sizing is too generous and should be restated, not quietly dropped.

## ⚠ And a correction to how M2 is being read tonight

My hand-derivation reads **29.7 %** (1,841 of 6,190) right now, against the published `allday_fmv_high_med_share_pct` = **25.6 %** at the 01:48Z leg. ⛔ **That is NOT a +4 point gain and must not be recorded as one.** The two definitions are identical (I read the precompute's source), so the difference is **sweep position** — go-live-2026-09.md already documents this metric swinging **22.59 → 24.07 → 28.3 → 23.0 inside nine hours**, and its own rule is that *"no single leg is a level for M2 while the sweep is mid-cycle."* Sweep is **54.1 %**; the fresh-cohort share is **47.3 %**. **29.7 % is a favourable sampling point, exactly like the retracted 28.3 %.**

## ✅ Separately: #70's "coincident and unexplained" cadence drop is ANSWERED, and it is not a cause

#70 flagged that `allday-sales-indexer`'s run count fell **~100–110 → ~78/day around 08-26/27** and called finding the cause *"the cheapest next step"*, with the condition: *"If a per-run cap is being hit, fewer ticks WOULD lose rows and this becomes the cause rather than a coincidence."*

⭐ **It was a SCHEDULE CHANGE, not a fault, and it hit five lanes at once.** Runs/day across the step: `allday-sales-indexer` 102 → 86 → **73**, `topshot-sales-indexer` 97 → 86 → 72, `golazos-sales-indexer` 101 → 88 → 73, `allday-edition-resolver` 99 → 86 → 73, `allday-unmapped-resolver` 102 → 89 → 73 (08-25 → 08-26 → 08-27). ⭐ **Control: `pinnacle-sales-indexer` is FLAT at 71 throughout** — so it is one scheduler group, not the instance.
⭐ **The new cadence is visible in the minute histogram: :16, :36, :56, exactly 24 runs each in 24 h — a 20-minute cron** (72/day) plus ~6 stragglers. 108/day implies ~13 minutes before. **So these lanes were re-timed 15 → 20 minutes.**

⛔ **And the per-run-cap condition is NOT met, so the re-timing is exonerated:** `blocks_scanned` is **~1,500/run** (1,497 · 1,502 · 1,503) against the **~1,200 blocks** Flow produces in 20 minutes, and the cursors are **at the head** — `allday_sales` is **523 blocks** behind the newest cursor in the table (~9 minutes), `golazos_sales` 894, `pinnacle_sales` 1,416, `topshot_sales` 0. **A lane at the head has lost nothing to a slower tick.** ⚠ `allday_listings` IS 15,868 blocks (~4.4 h) behind — that is the nine-lane backstop collapse in the 05:40Z filing, not this.

**So #70's remaining cause is upstream volume, as its own Dune measurement concluded — and the cadence line can be closed rather than left as a live suspicion.**

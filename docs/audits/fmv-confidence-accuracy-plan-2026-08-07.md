# "Fully confident on everything" — FMV accuracy diagnosis + lever plan (2026-08-07, Claude Code)

Trevor's directive: *"I don't want the confidence tags. Frankly, we should be fully confident on everything."* The tags are a band-aid; the goal is to make the underlying FMV genuinely trustworthy so editions ARE high-confidence, not labeled as uncertain. This turns that goal into a measured, prioritized plan. **All figures live 2026-08-07; read-only, nothing changed.**

## 1. Where we stand (live `fmv_current`, HIGH/MEDIUM = sales-backed)

| Collection | Priced eds | HIGH+MED | % HIGH/MED | ASK_ONLY | LOW | STALE | NO_DATA |
|---|---|---|---|---|---|---|---|
| Candy MLB | 125 | 73 | **58.4%** | 0 | 52 | 0 | 0 |
| NBA Top Shot | 19,532 | 6,627 | **33.9%** | 3,070 | 5,334 | 1,106 | 3,367 |
| NFL All Day | 6,190 | 1,530 | **24.7%** | 1,304 | 1,593 | 772 | 979 |
| LaLiga Golazos | 575 | 1 | **0.2%** | 106 | 94 | 298 | 76 |
| UFC Strike | 465 | 0 | **0.0%** | 0 | 0 | 149 | 316 |

## 2. The root cause is thin per-edition trading, NOT unmatched data

The tempting hypothesis — "editions look unconfident because their real sales sit unresolved in `unmapped_sales`" — is **largely false for RECENT data**. Live unmapped counts:

| Collection | unmapped total | last 30d | last 7d |
|---|---|---|---|
| NFL All Day | 98,653 | **638** | 379 |
| LaLiga Golazos | 155 | 24 | 2 |
| NBA Top Shot | 24,583 | **0** | 0 |
| UFC Strike | 1,554 | 0 | 0 |

Top Shot has **zero** recent unmapped sales; All Day's recent unmapped (638/30d) is a modest lever. So resolving unmapped is worth doing but will **not** move the headline — the gap is that most editions genuinely trade fewer than 5× in 30 days. You cannot be sales-confident about an edition that rarely trades, and manufacturing confidence would be the exact dishonesty the roadmap forbids.

## 3. The biggest honest lever: the confidence **window** (30d → 90d/180d)

Confidence today keys off `sales_count_30d` (`lib/fmv-confidence.ts`: MEDIUM ≥5 sales/30d, HIGH ≥7 + tight dispersion). Most editions DO trade — just over a longer horizon. Measured on Top Shot (real sales):

| MEDIUM volume floor (≥5 sales) evaluated over… | eligible editions |
|---|---|
| 30 days (today) | 3,713 |
| **90 days** | **8,106** (2.2×) |
| 180 days | 10,535 (2.8×) |

(12,303 of ~19.5k TS editions traded at least once in 180d; 8,443 in 30d.) **Widening the window ~doubles the sales-backed population using real, honest data.** This is the single highest-yield accuracy change.

**It is a genuine model decision (yours), because it has a real tradeoff:** a 90-day median is a more defensible "recent price" for a thinly-traded collectible, but it is staler — a moment that fell 60 days ago would read high. Two coherent shapes:
- **(a) Widen both** the confidence window AND the FMV value window (the value is currently 30d WAP + days_since_sale). Consistent, simplest to reason about.
- **(b) Tiered**: keep the 30d value where liquid, fall back to a 90d median (clearly a "90-day average") only where 30d is too thin — more accurate but more moving parts.

I can implement either with tests once you pick the window + shape. **This is off-limits for me to change blind** (FMV pricing math), which is why it's a decision, not a drive-by.

## 4. The other real levers, in priority order

1. **Window widening (§3)** — ~doubles sales-backed coverage platform-wide. Your decision on window + shape.
2. **All Day dispersion recalibration** — 533 All Day editions have ≥7 sales/30d but are demoted to LOW by the serial-residual dispersion gate (≥0.35). Either the model is miscalibrated for All Day or those prices genuinely scatter. **Cannot tell from stored data** — the fix is read-only telemetry: log the per-edition dispersion for one recalc sweep, histogram it, then decide. Safe to build on your OK (it touches `fmv-recalc`, so I want the nod). See `docs/audits/allday-fmv-confidence-diagnosis-2026-08-07.md`.
3. **Resolve recent unmapped** — All Day 638/30d + Golazos 24/30d back into `sales`. Small but pure-win data completeness (the resolver already exists; this is about its throughput/backlog, `unmapped_resolution_backlog_max` has been breaching).
4. **Structural — cannot be sales-confident, and that's correct:**
   - **UFC (0%)** — market closed, zero sales in 30d. No window or model produces an honest UFC sale price. The right answer is the closed-market treatment already shipped, not confidence.
   - **Golazos (0.2%)** — ~131 sales/30d across 575 editions; even a 180d window leaves most editions thin. Largely a "not enough trading to price from sales" collection.
   - **NO_DATA editions** (TS 3,367 / AllDay 979) — never-traded / no usable signal. Honest floor.

## 5. What "fully confident on everything" realistically means
- **Achievable and worth doing:** roughly double Top Shot + All Day sales-backed coverage via the window lever (§3), plus recover the dispersion-demoted All Day editions (§4.2) and the recent unmapped (§4.3).
- **Structurally impossible (and correct to leave):** a dead market (UFC) and never-traded editions cannot be sales-confident. For those, "fully confident" means being confident about the *right thing* — that there is no reliable price — which is a display/coverage decision, not a math one.

## 6. The decisions I need from you to proceed
1. **Confidence/value window** (§3): stay 30d, or widen to 90d / 180d — and shape (a) uniform vs (b) tiered? (Biggest lever; I implement + test once chosen.)
2. **All Day dispersion telemetry** (§4.2): OK to add read-only logging to `fmv-recalc` for one sweep so we can decide the dispersion gate on data?
3. Anything you want explicitly left structural (UFC, Golazos tail, NO_DATA).

Nothing here was changed. This is the plan; pick a window and I'll build it.

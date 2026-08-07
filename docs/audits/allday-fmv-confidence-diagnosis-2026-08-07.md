# All Day FMV confidence — read-only diagnosis (2026-08-07, Claude Code)

Roadmap Gate 2 item 6 (`docs/strategy/roadmap-2026-08-03.md` §4) reads: *"All Day FMV: 6.3% → the Top Shot band or better. A collection with 17,240 sales in 30 days has no excuse for a 6.3% sales-backed rate. Diagnose the confidence pipeline, not the market."* This is that diagnosis. **No pipeline change was made — confidence thresholds are Gate 2 FMV math and Trevor's call.** This doc is the evidence for that decision.

## Headline: the roadmap's 6.3% is stale — All Day is already ~26.5% HIGH/MEDIUM

The dust-floor removal (`3809425b`) + the full recalc sweep that completed *after* the 08-03 roadmap have already moved All Day ~4×. Live `fmv_current` for `nfl_all_day` (collection `dee28451-…`), measured 2026-08-07:

| confidence | editions | avg sales/30d | ≥2 sales/30d | avg days-since-sale |
|---|---|---|---|---|
| MEDIUM | 1,351 | 7.87 | 1,343 | 12.0 |
| HIGH | 290 | 10.92 | 289 | 11.3 |
| LOW | 1,477 | 5.89 | 1,229 | 14.2 |
| ASK_ONLY | 1,307 | 0 | 0 | 386 |
| NO_DATA | 979 | 0 | — | — |
| STALE | 774 | 0 | — | 244.8 |
| SALES_ONLY | 12 | 6.00 | 7 | 431.4 |

**HIGH+MEDIUM = 1,641 editions ≈ 26.5% of 6,190** (≈31% of the 5,239 priced). This corroborates the CLAUDE.md 08-07 overnight note ("AllDay HIGH+MED 1586→1713"). The single biggest Gate-2 lever the roadmap named is largely *already banked* by the dust-floor work — **re-baseline the roadmap's 6.3% before treating it as the current gap.**

## Where the remaining LOW population actually is

The confidence rule (`lib/fmv-confidence.ts`): base MEDIUM at ≥5 sales/30d; HIGH needs ≥7 sales **and** serial-residual log-dispersion <0.20; an edition with ≥7 sales but dispersion ≥0.35 is **demoted back to LOW** ("enough volume, too noisy"); a live ask agreeing within ±25% rescues LOW→MEDIUM at ≥3 sales.

The 1,477 LOW All Day editions split cleanly:

| LOW sub-population | editions | interpretation |
|---|---|---|
| 1–4 sales/30d (below the MEDIUM floor) | **933** | genuinely thin — LOW is defensible; the ask-corroboration path can only rescue the 3–4-sale subset that also has an agreeing live ask |
| **7+ sales/30d, dispersion-demoted** | **533** | actively traded yet flagged too noisy after the serial-residual fit — **this is the real question** |
| 0 sales | 11 | edge |
| 5–6 sales | 0 | correctly promoted to MEDIUM by the volume floor |

## The one question that needs Trevor's call

**Are the 533 dispersion-demoted editions honestly noisy, or is the serial-residual model miscalibrated for All Day?**

- If All Day prices genuinely scatter >0.35 in log-residual after removing the serial effect, LOW is the honest label and there is nothing to fix — the collection just trades noisily.
- If the log-linear `ln(price) = a + b·ln(serial)` fit is a poor model for All Day (e.g. All Day serial premiums are not log-linear, or non-serial attributes — moment tier, play rarity — drive the spread the fit attributes to noise), then up to 533 actively-traded editions are being *under*-rated, and the lever is a better dispersion model or an All-Day-specific `MEDIUM_MAX_DISPERSION`, not more ingest.

**This cannot be answered from stored data** — the per-edition dispersion value is computed transiently inside `fmv-recalc` and is not persisted to `fmv_snapshots`. The cheap, safe, read-only next step (Trevor to greenlight) is to **instrument `fmv-recalc` to log the computed dispersion (and the sales-price CV) per edition into `pipeline_runs.extra` or a scratch column**, run one sweep, then histogram the 533. That data decides between "honest noise" (do nothing) and "recalibrate" (a specific, measured threshold or model change) — without guessing at thresholds.

## Also worth noting (not the headline, but real)

- **1,307 ASK_ONLY** editions (0 sales/30d, ~386 days since last sale) carry a live ask but no recent trade. These are correctly *not* sales-backed; whether the ask should render as the price or the edition should show `—` is the roadmap's §4 item 8 staleness-policy question (applies to All Day too, not just Top Shot).
- **774 STALE + 979 NO_DATA** = 1,753 editions with neither a recent sale nor a usable ask. Honest gaps; the roadmap's "render `—` with a reason" rule already covers them.

## What was NOT done, and why
No threshold, model, or pipeline change. Per CLAUDE.md, FMV confidence math is off-limits for autonomous shipping, and per this roadmap's own §7 the right move is to *measure the instrument* (log the dispersion) before touching the system. This doc is that pre-work.

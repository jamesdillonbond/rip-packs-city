# Panini: a predictive FMV for never-sold editions (2026-11-27, Claude Code cloud)

**Trigger (Trevor, 11-27):** "The asking price shouldn't really matter. We need to come up with a predictive fmv for this, based upon what we've seen elsewhere." Case: `/panini-blockchain/edition/packcard-2130_415553_3` (Rolling Stones, Behind the Scenes Prizms Black Finite, **1/1**, never sold, listed at $1,968), FMV **$984** = ask × 0.5 (`PANINI_ASK_ONLY_MULT`, `lib/chains/panini/ingest-normalize.ts`). Its only priced sibling, the /99 Silver of the same card, sells for ~$3.

**Status: ✅ SHIPPED 2026-11-27 ~8:42 AM PT — Trevor chose the blend.** Migration `20261127164214_audit_20261127_panini_ask_only_comps_blend` (BEFORE INSERT trigger `fmv_snapshots_blend_panini_ask_only_to_comps_trg` + `panini_comps_estimate(text)` + a one-time re-stamp). 2,590 editions re-priced (1,596 down, 994 up), $667k → $276k, each in `fmv_restatements`; the Rolling Stones 1/1 is now $328.23. Still owed: the forward test (score the published price against every first sale from 11-27 on) and an out-of-sample refit of the bucket parameters.

## The comparables model (fit on REAL sales, never FMV, to avoid circularity)

A card's identity is product (`product_set_id`) + subject (`player_name`) + card number (the external_id's last segment). Each sold printing (365-day median sale) is paired with the same card's most common sold printing, the **anchor**. 24,392 pairs.

`pred = anchor_median × exp(a_b + β_b · ln(anchor_mint / target_mint))`, with the intercept and slope fitted per target-mint bucket:

| target mint | pairs | β | a | ⇒ ×anchor at a typical mint ratio |
|---|---:|---:|---:|---|
| 1 | 574 | 0.496 | 1.318 | /1 vs /99 → ×36 (median observed ×42 at ratio 259) |
| 2–5 | 858 | 0.523 | 0.102 | |
| 6–10 | 4,223 | 0.558 | 0.362 | |
| 11–25 | 4,434 | 0.417 | 0.597 | |
| 26–99 | 8,842 | 0.137 | 0.338 | |
| 100+ | 5,462 | 0.077 | −0.049 | |

A single power law (β 0.61, r² 0.30) misses 1/1s by ×2.75 (the 1-of-1 premium), hence the buckets. Within a bucket the mint ratio explains little (r² 0.01–0.17): the bucket intercept carries most of the signal.

Rolling Stones 1/1: comparables **≈ $110**; blend (below) **≈ $330**; today **$984**.

## Backtest: does it predict the FIRST sale better than what we published?

Population: editions whose first-ever sale was in the last 60 days and whose snapshot just before was ASK_ONLY, with a same-card anchor sold in the 365 days BEFORE that sale (no look-ahead on prices). **n = 1,035.** Metric: median |ln(actual / predicted)|, and the share within ±25 %.

| predictor | MdAE all | within ±25 % | MdAE mint ≤ 10 (556) | MdAE mint > 10 (479) | ±25 % mint > 10 |
|---|---:|---:|---:|---:|---:|
| published (ask × 0.5) | 0.693 | 20.2 % | 0.693 | 0.693 | 22.5 % |
| comparables only | 0.777 | 15.5 % | — | — | — |
| comparables capped at the ask | 0.693 | 18.5 % | 0.752 | 0.675 | 20.0 % |
| **blend = √(published × comparables)** | **0.579** | **21.4 %** | **0.662** | **0.480** | **28.0 %** |

⚠ **Read these with the selection bias in mind.** The published rule's MdAE is exactly ln 2 because a first sale is often someone buying the listing AT the ask (= 2 × published). The backtest can only see editions that DID sell, so it favours any predictor built on the ask. The over-asked editions Trevor is worried about (a $1,968 ask on a $3 card's 1/1) are exactly the ones that never fill and never enter it. Comparables-only losing here is therefore not evidence that the ask is right for those. A forward test, scoring both on every first sale from the ship date, is the instrument that can settle it.

(The bucket parameters are fitted on all 365-day pairs, which overlap the backtest anchors: a mild in-sample advantage for the model, worth refitting out-of-sample before shipping.)

## Scope

2,854 Panini editions are ASK_ONLY today ($756k of FMV); 2,611 have a same-card anchor. The other 243 have no same-card sold printing; they would need a second route (same product + same parallel, other subjects), which is not measured yet.

## Options (Trevor's call)

1. **Ship the blend** for anchored ASK_ONLY editions (the only variant that beats today's rule on the backtest), labelled as a comparables estimate, with `fmv_restatements` rows so the 7-day market-cap change does not read it as a market move. Add the forward test.
2. **Ship comparables-only** (the ask ignored, as you asked), accepting a worse first-sale backtest for now, and judge it on the forward test, which the backtest cannot do for over-asked cards.
3. **Comparables-only for 1/1 and ≤ /5 only** (where one listing is most likely to be a wish price), blend elsewhere.

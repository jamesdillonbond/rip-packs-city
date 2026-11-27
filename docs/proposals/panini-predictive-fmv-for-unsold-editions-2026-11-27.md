# Panini: a predictive FMV for never-sold editions (2026-11-27, Claude Code cloud)

**Trigger (Trevor, 11-27):** "The asking price shouldn't really matter. We need to come up with a predictive fmv for this, based upon what we've seen elsewhere." Case: `/panini-blockchain/edition/packcard-2130_415553_3` (Rolling Stones, Behind the Scenes Prizms Black Finite, **1/1**, never sold, listed at $1,968), FMV **$984** = ask × 0.5 (`PANINI_ASK_ONLY_MULT`, `lib/chains/panini/ingest-normalize.ts`). Its only priced sibling, the /99 Silver of the same card, sells for ~$3.

**Status: ✅ SHIPPED 2026-11-27 ~8:42 AM PT — Trevor chose the blend.** Migration `20261127164214_audit_20261127_panini_ask_only_comps_blend` (BEFORE INSERT trigger `fmv_snapshots_blend_panini_ask_only_to_comps_trg` + `panini_comps_estimate(text)` + a one-time re-stamp). 2,590 editions re-priced (1,596 down, 994 up), $667k → $276k, each in `fmv_restatements`; the Rolling Stones 1/1 is now $328.23. **Follow-ups shipped ~8:57 AM PT in `20261127165742_audit_20261127_panini_ask_only_comps_route2`:** (1) **out-of-sample refit** — parameters refitted only on sales older than 60 days score the backtest first sales at MdAE 0.553 vs 0.558 in-sample (old rule 0.693), so the shipped parameters stand (no price churn); (2) **second route** for the 241 cards with no sold same-card printing — the 365-day median sale of the same parallel (`set_name`) in the same product, used only with ≥ 3 such sales (backtest on 71 no-anchor first sales: MdAE 0.464 → 0.379, WAPE 0.826 → 0.479); 107 re-priced (66 down), $9,894 → $2,750, each in `fmv_restatements`; the other 134 have too few comparable sales and stay on the ask rule; (3) **forward test** — `select public.panini_comps_forward_test()` (service_role) scores every first sale after the ship time against the price published just before it, split `comps` vs `ask_rule`. Empty at ship; read it after a week against the 0.69 baseline.

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

## Tested and NOT shipped: a third route (same print run, same product) — 2026-11-27 ~9:25 AM PT

For the 134 cards left on the ask rule (mostly 1/1s, ~$79k combined), tried "median sale of other editions with the same `mint_cap` in the same `product_set_id`, ≥ 3 sales", backtested point-in-time (only sales before each card's first sale). Of 1,587 ASK_ONLY first sales, just 10 fell outside routes 1–2, and 7 had a route-3 estimate. On those 7 it was WORSE: MdAE 0.598 (published) → 0.748 (blend), WAPE 0.437 → 0.704. Too few cases to trust and pointed the wrong way, so these stay on the ask rule; the forward test (`panini_comps_forward_test()`) will show whether that arm is the weak one.

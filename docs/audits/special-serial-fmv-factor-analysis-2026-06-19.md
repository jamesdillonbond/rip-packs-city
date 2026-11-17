# Special-Serial FMV — Factor Analysis (2026-06-19)

Evidence pass for the multi-factor special-serial FMV model (Trevor's ask: weigh player, badge, set, series, parallel, circulation, team, tier — based on sales history). Read-only EDA against Supabase `bxcqstmqfzmuolpuynti`. **No pricing logic was changed.** This sharpens the model spec in `docs/strategy/topshot-sales-completeness-and-serial-fmv-2026-06-19.md` §6 and feeds CC Item 5.

## Method + caveats

- **Universe:** the **939 modelable special-serial sales** — TS sales of serial #1, perfect (#N/N), or jersey-match, where the edition has a HIGH/MEDIUM base FMV to normalize against. (Total special-serial sales are ~1,086 #1 + 627 perfect + jersey, but only those with a trustworthy base FMV are modelable today — the sample grows directly with the sales-completeness backfill.)
- **Target:** `premium = sale_price / base_fmv`, analyzed in log space (`y = ln(premium)`).
- **Caveat 1 (premium proxy):** base FMV is the edition's *latest* HIGH/MED snapshot, not the FMV contemporaneous with the sale. This adds noise but doesn't create spurious factor signal — if a factor still explains variance through the noise, it's real.
- **Caveat 2 (η² cardinality inflation):** raw η² (between-group variance ÷ total) is mechanically inflated for high-cardinality factors — a factor with one sale per level "explains" everything. So η² is only honest for **low-cardinality** factors (tier, circ_band, series, team, bucket). High-cardinality factors (player, set, parallel) carry real signal but their η² is an overstatement; the true contribution emerges only under pooling/shrinkage.

## Finding 1 — the current model leaves the majority of variance unexplained

The live model (`serial_fmv_power_model`) groups only by **tier × bucket**. That grouping explains **η² ≈ 0.41** of log-premium variance → **~58% is unexplained.** Worse, the dispersion *inside* each tier×bucket cell is large — log-premium SD by cell:

| bucket | tier | n | SD(log-premium) | premium p25 → p75 |
|---|---|---|---|---|
| first | COMMON | 204 | 1.01 | 13.2× → 52.1× |
| first | FANDOM | 35 | 1.54 | 8.4× → 50.6× (max 2,084×) |
| first | RARE | 166 | 0.82 | 3.9× → 9.9× |
| first | LEGENDARY | 59 | 0.74 | 1.7× → 4.1× |
| jersey | COMMON | 177 | 1.11 | 10.9× → 40.0× |
| perfect | COMMON | 51 | 1.44 | 2.8× → 16.5× |

A single tier×bucket cell routinely spans a 4–6× interquartile premium range. That residual is what the additional factors are there to explain.

## Finding 2 — factor ranking (η², cardinality-adjusted)

| factor | levels | η²_raw | median sales/level | honest read |
|---|---|---|---|---|
| **circulation (band)** | 5 | **0.343** | 161 | **clean + strong** — the standout low-cardinality factor |
| tier | 4 | 0.337 | 224 | clean; already in the model |
| tier+bucket (current model) | 12 | 0.415 | 56 | baseline |
| **set** | 78 | 0.419 | 3.5 | inflated, but real strong signal (premium-set effect) |
| **player** | 365 | 0.520 | 2.0 | inflated; real but **needs shrinkage** (med 2 sales/player) |
| team | 50 | 0.111 | 18 | modest |
| bucket | 3 | 0.074 | 350 | small alone; matters as a tier interaction |
| series | 8 | 0.017 | 43 | **negligible** |
| parallel (play) | 595 | 0.865 | 1.0 | **overfit/unusable** at current N (≈1 sale/level) |

## Finding 3 — circulation is the biggest clean lever (and it's counterintuitive)

Median #1/special premium **multiple** by circulation band:

| circulation | n | median premium |
|---|---|---|
| < 40 | 23 | 2.75× |
| 40–99 | 67 | 1.92× |
| 100–499 | 325 | 5.24× |
| 500–1,999 | 370 | 17.99× |
| 2,000+ | 162 | 30.40× |

The premium *multiple* **rises** with circulation — a #1 of a 4,000-print common trades at ~30× its (low) base FMV, while a #1 of a 40-print legendary trades at ~2.75× its (already high) base. This is the inverse-value relationship the power law (`price = k·fmv^β`, β<1) only partially captures. **Circulation should be an explicit continuous term — `log(circulation)` — not just the coarse `circ_band` the fallback grid uses.**

## Finding 4 — set is a strong, honestly-sampled factor (the de-facto "badge" signal)

Median #1 premium by set (well-sampled, n≥6): Extra Spice 47×, Base Set 46×, 2026 NBA Playoffs 41×, Top Shot This: Playoffs 35×, Bag Work 32× … down to Rookie Debut 11×, Metallic Gold LE 5.6×, Freshman Gems 5.6×. A ~9× spread across sets with real samples. Set partly correlates with circulation (common-tier base sets are high-circ), which the multivariate model with pooling untangles. Set is the closest available proxy for the **badge/premium-set** factor Trevor named.

## Implications for the model spec (refines strategy §6)

1. **Continuous terms (first-class):** `log(base_fmv)` (the existing power-law term) **and `log(circulation)`** — circulation is the strongest clean factor and is currently underused.
2. **Pooled categorical (shrinkage mandatory):** `set`, `player`. η² confirms real signal, but median 2–3.5 sales/level means raw fixed effects overfit — ridge / mixed-effects / partial pooling is not optional, it's the whole point.
3. **Keep:** `tier` and the `tier×bucket` interaction (clean, ~34% / baseline).
4. **Down-weight or drop:** `series` (η²=0.017, negligible), `team` (η²=0.11, mostly subsumed by player), and **`parallel`/play** — η²=0.87 is pure overfit at N=939 (≈1 sale/level); it only becomes a usable factor as the sales-completeness backfill multiplies the per-parallel sample. This is the cleanest illustration that **the model's ceiling is set by data volume**, which is exactly what Levers 1–2 raise.
5. **Badge factor:** not directly tested — there is no clean bulk per-edition badge table today (`editions.badges` is empty; badges come from the `get_edition_badges_unified` RPC per edition). `set_name` is a strong proxy (premium/badge-bearing sets cluster high). Adding explicit badges (`badge_taxonomy`) is a refinement once a bulk per-edition badge join exists — worth doing, but set already captures most of it.

## What this de-risks

- **The multi-factor model is justified** — the current model leaves ~58% of premium variance on the table, and circulation + set + (pooled) player demonstrably recover a meaningful chunk.
- **The technique is confirmed:** pooling is mandatory (player/set/parallel all overfit raw), so the model must be a **pooled hedonic regression**, not a bigger lookup grid — as specified.
- **The data dependency is quantified:** parallel and most players are too sparse *today*; the precise pooled R² and the production fit are the first outputs of CC Item 5, run **after** the backfill grows the special-serial sample (the scheduled watch `ts-backfill-drain-serial-fmv-watch` pings when it's there).

Build trigger and full model spec: `docs/handoff-2026-06-19-ts-sales-completeness-and-serial-fmv.md` Item 5 + strategy §6.

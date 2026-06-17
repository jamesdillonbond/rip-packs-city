# Proposal (review-gated) — FMV-aware serial multiplier for `serial_fmv_estimate`

**Status: PROPOSAL for sign-off. Nothing applied. `serial_fmv_estimate` is live pricing logic — do not edit inline; this needs review.**

**v2 (2026-06-17, verified):** the model below was re-fit against live data, a sampling bug in v1 was found and corrected, the functional form was settled head-to-head, and the full live board was run through an acceptance test. A staged, reviewed migration sits beside this file at `serial-fmv-power-model-STAGED-MIGRATION.sql` (NOT applied). The board (`/insights/underpriced-serials`) is live and healthy regardless — the `estimate_quality='coarse'` label already shields users from the overstatement; this makes the underlying estimate honest so more rows can read `tight`.

This extends the COMMON-#1 sketch in `serial-fmv-common-no1-desirability-2026-06-17.md` to all serial buckets.

## Problem (validated)

`serial_fmv_estimate` multiplies edition FMV by a flat per-`(tier, circ_band, serial_bucket)` multiplier from `serial_fmv_multipliers`. (Precisely: the grid stores `median(serial_sale_price ÷ that-edition's-own-median-sale-price)`, then the estimate applies that ratio to the edition's FMV. For HIGH/MEDIUM editions fmv≈median so it behaves as a multiple-of-FMV.)

Live #1/perfect sales show the realized multiple **decays sharply as edition FMV rises** — the absolute #1/perfect price grows *sublinearly* with edition FMV, so a flat multiplier overstates high-FMV editions badly. This is live on the deal board AND on moment pages / collection tiles / the trophy picker (`a3db4235`).

Worst live example: **Kevin Durant Holo Icon perfect 62/62 — estimate $1,117 (7.78× × $143.67 FMV), but a high-FMV perfect realizes ~1× → ~$144 true value.**

## Model

`serial_price ≈ k · edition_fmv^β` per cell — a power law (β<1 produces the decay). Fitted by log-log OLS on Top Shot #1/perfect sales, last 180d (`regr_slope`/`regr_intercept` on `ln(price)` vs `ln(fmv)`), joined to each edition's latest snapshot.

### v1 sampling bug — FIXED (the central correction in v2)

v1 fit on **all** confidences. But `serial_fmv_estimate` hard-gates on `confidence IN ('HIGH','MEDIUM')` — it only ever prices HIGH/MED editions. Re-fitting on that production-faithful population (the `prod n` below) versus v1's all-confidence `n`:

| bucket | tier | v1 n (all-conf) | **prod n (HIGH/MED)** | β (HIGH/MED) | k | r | verdict |
|---|---|---|---|---|---|---|---|
| first | COMMON | 325 | **168** | 0.494 | 38.31 | 0.44 | **use model** (noisy but ~2× better than grid) |
| first | RARE | 185 | **125** | 0.878 | 7.13 | 0.80 | **use model** (good fit) |
| first | LEGENDARY | 106 | **54** | 0.896 | 4.23 | 0.80 | **use model** (good fit) |
| first | FANDOM | 47 | **34** | −0.366 | 287 | −0.30 | **BROKEN fit** — do NOT model; falls to grid (open item) |
| perfect | COMMON | 40 | **14** | 0.358 | 12.19 | 0.51 | too thin per-tier → pooled |
| perfect | RARE | 42 | **21** | 1.348 | 1.16 | 0.69 | **unstable** (super-linear; flips vs v1's 0.879) → pooled |
| perfect | LEGENDARY | 27 | **6** | — | — | — | **unfittable** (78% of v1 sample can't be priced) → pooled |

Two consequences v1 missed:
1. **The perfect-mint per-tier cells collapse under the real gate** (n=6/14/21, unstable). v1's headline fix (KD perfect) was in its *weakest-supported* cell.
2. The fix is to **pool perfect across tiers** and let the FMV term carry the tier spread.

### Final model (production-faithful; the staged migration fits this dynamically)

- **`first`: per-tier** — COMMON `k=38.3,β=0.49` · RARE `k=7.1,β=0.88` · LEGENDARY `k=4.2,β=0.90`. (Tiers are well-separated; pooling would understate RARE/LEGENDARY #1s.)
- **`perfect`: pooled (all tiers, tier='ALL')** — **`k=9.94, β=0.536, r=0.74, n=41`**. Predicts **$142 at KD's $143.67 FMV** ≈ realized $144, with a sound fit and no thin per-tier cell.
- **FANDOM `first`**: broken fit → not modeled → existing grid path (unchanged, still `coarse`). Disposition open (below).

### Functional form — settled head-to-head

Power law vs the COMMON-sketch's additive `FLOOR+SLOPE·fmv` vs flat grid, on COMMON #1 (HIGH/MED, n=168), median absolute % error in $ space:

| model | median \|%err\| |
|---|---|
| flat grid (52.5×) | 91.6% |
| additive ($26.33 + $21.34·fmv) | 68.5% |
| **power law (38.31·fmv⁰·⁴⁹⁴)** | **52.2%** |

Power law wins → it is the chosen form (and supersedes the additive Option A in the COMMON sketch). **Honest caveat:** even the best model has ~52% median error on COMMON #1 (r=0.44 — FMV explains ~20% of #1-price variance). So COMMON #1 stays `coarse` (label) even after the change; the win is "roughly right instead of 2–4× high," not precision.

## Acceptance test (full live board, 43 rows — power-law vs current)

| moment | bucket/tier | FMV | ask | current est | **model est** | verdict |
|---|---|---|---|---|---|---|
| KD perfect 62/62 | perfect/LEG | $144 | $650 | $1,117 | **$144** | ✓ not-a-deal (was fake 42% off) |
| Azzi Fudd #1 | first/COMMON | $40 | $1,500 | $1,523 | **$235** | not-a-deal |
| Isaiah Collier perfect | perfect/LEG | $89 | $199 | $694 | **$110** | not-a-deal (was "71% off") |
| Jalen Green perfect | perfect/LEG | $64 | $79 | $502 | **$93** | still a deal (~15%, honest; was fake 84%) |
| CJ McCollum perfect | perfect/LEG | $51 | $69 | $394 | **$82** | still a deal (~15%) |
| Vinnie Johnson #1 | first/LEG | $177 | $300 | $454 | **$437** | still a deal (~31%) |
| Maxime Raynaud #1 | first/RARE | $51 | $200 | $275 | **$223** | still a deal (~10%) |
| Jordan McLaughlin #1 | first/COMMON | $2.1 | $14 | $110 | **$55** | still a strong deal (~75%) |

The model collapses inflated estimates, flips the false deals to not-a-deal, and keeps genuine deals at honest discounts. **Net effect on the board:** of the 43 current "deals," roughly **15 survive** as honest deals; the rest (high-FMV commons + inflated perfect-legendaries) correctly drop off (ask now ≥ estimate). That is the acceptance bar.

A nice fall-out: the staged function returns the **effective** multiplier (estimate÷fmv), so the board view's existing `estimate_quality` CASE keeps working and **auto-relaxes** — KD perfect's effective mult ≈1.0 flips it to `tight` with **no view change**. The old "separate estimate_quality relaxation step" is mostly absorbed here (COMMON #1 still reads `coarse` by the CASE's COMMON carve-out — correct, given its noise).

## Implementation — see the staged migration

`serial-fmv-power-model-STAGED-MIGRATION.sql` (beside this file, **NOT applied**) contains the full reviewed SQL:
1. `serial_fmv_power_model(collection_id, serial_bucket, tier, k, beta, sample_size, r, fmv_min, fmv_max, is_reliable, computed_at)` — service_role-only, RLS on.
2. `compute_serial_fmv_power_model()` — log-log OLS fit (HIGH/MED only; per-tier first, pooled perfect); reliability gate `n≥40 AND r≥0.35 AND 0.15<β<1.25` (admits COMMON despite r=.44; rejects FANDOM's β<0). Runs from the weekly refresh cron alongside `compute_serial_fmv_multipliers`.
3. `serial_fmv_estimate` (CREATE OR REPLACE) — power-law where a reliable cell exists; **clamps fmv into the fitted `[fmv_min,fmv_max]` domain** to bound extrapolation; floors at edition fmv; otherwise falls through to the **existing grid path unchanged**. Grants re-asserted (anon/authenticated/service_role/postgres).

So the migration is a strict improvement on the modeled cells and a no-op everywhere else.

## Open review decisions

1. **FANDOM #1** — broken fit (β<0). Default in the staged migration: leave on the grid (unchanged, $743-class `coarse`). Alternatives: (a) suppress FANDOM #1 serial estimates entirely (return NULL → drop from board), or (b) pool FANDOM into the `first` aggregate. Recommend **suppress** until there's data — showing a known-broken number is worse than showing none. **Your call.**
2. **estimate_quality** — the auto-relaxation via effective-multiplier is enough for perfect/RARE/LEGENDARY. Confirm COMMON #1 should stay permanently `coarse` (recommended — r=0.44).
3. **Reliability thresholds** — `n≥40, r≥0.35`. COMMON (r=.44) passes deliberately. Confirm or tighten.
4. **Operator dependency** — `refresh-serial-fmv-multipliers` cron currently has **0 runs** (ledger SERIAL-FMV-MULT-CRON). The model table goes stale exactly like the grid until that cron fires AND is extended to call `compute_serial_fmv_power_model()`. Wire both, or accept a manual periodic refresh.

## Reproduce / acceptance queries
All fits and the board acceptance test were run live on 2026-06-17 (project `bxcqstmqfzmuolpuynti`). Fit: `ln(price) ~ ln(fmv)` over `sales` (`collection='nba_top_shot'`, `serial_number=1 OR =circulation_count`, `sold_at>now()-180d`, `price_usd>0`) joined to `DISTINCT ON(edition_id)` latest `fmv_snapshots` filtered `confidence IN ('HIGH','MEDIUM')`, grouped per `(bucket,tier)` with `regr_slope`/`regr_intercept`/`corr`. Acceptance: apply `GREATEST(fmv, k·fmv^β)` to `topshot_underpriced_serials_board` rows; compare to `serial_fmv_usd`, `ask_usd`.

## Gate
This proposal applies nothing. The staged SQL is a reviewed artifact, not an `apply_migration`. Sign off the open decisions above, then run it in a dedicated migration session. Pre-change `serial_fmv_estimate` body for revert: the current grid-multiplier body (`GREATEST(p_edition_fmv, p_edition_fmv * v_mult)` after the `serial_fmv_multipliers` tier/circ lookup), captured live via `pg_get_functiondef` in this session's transcript.

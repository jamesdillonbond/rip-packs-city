# Proposal — player-desirability factor for COMMON #1 serial-FMV estimates (REVIEW-GATED, NOT applied)

Date: 2026-06-17 · Author: Claude Code · Status: **PROPOSAL ONLY — nothing applied to the live `serial_fmv_estimate`.**

This is the review-gated follow-up flagged in `docs/handoff-2026-06-16-underpriced-serials-ingest-build.md` ("Player-desirability factor for #1-common estimates"). `serial_fmv_estimate` is live pricing logic (off-limits to autonomous shipping per CLAUDE.md), so this draft is for Trevor's sign-off, not for shipping. The Underpriced #1s board itself is **live and healthy** and does not depend on this change — the `estimate_quality='coarse'` label already protects users from the overstatement; this proposal is about making more `coarse` rows honestly `tight`.

## The problem (restated, now quantified with quintiles)

The board's #1-COMMON estimates come from a **player-blind** multiplier grid: `serial_fmv_multipliers` is keyed only by `(collection_id, serial_bucket, tier, circ_band)`. `serial_fmv_estimate` does `estimate = GREATEST(edition_fmv, edition_fmv × multiplier)`. For COMMON #1s the grid multiplier is ~52× and is applied uniformly regardless of how desirable the edition is.

But desirability matters, and the direction is **inverse**: the realized #1 *multiple* falls sharply as edition FMV rises, because the absolute #1 price of a big common is a near-floor item.

### Evidence (live, 2026-06-17) — TS COMMON, circ ≥ 1000, real #1 sale in last 180d, n=127

Denominator = the edition's latest HIGH/MEDIUM `fmv_snapshots.fmv_usd` (the same `p_edition_fmv` the estimate consumes).

| FMV quintile | n | edition FMV range | median FMV | median #1 sale | **median realized multiple** |
|---|---|---|---|---|---|
| 1 | 26 | $0.51–1.07 | $0.86 | $33.00 | **40.9×** |
| 2 | 26 | $1.08–1.59 | $1.34 | $49.50 | **34.3×** |
| 3 | 25 | $1.59–2.21 | $1.87 | $39.00 | **21.3×** |
| 4 | 25 | $2.26–4.49 | $3.07 | $45.00 | **14.6×** |
| 5 | 25 | $4.90–21.37 | $7.61 | $106.00 | **10.9×** |

Two facts jump out:
1. **The multiple collapses 40.9× → 10.9×** across the FMV range — so a flat ~52× multiplier overstates the most desirable commons (quintile 5) by ~5× and even quintile 3–4 by ~2.5–3.5×.
2. **The absolute #1 price is far more stable than the multiple** — ~$33–50 across quintiles 1–4, rising to ~$106 only in the top quintile. A #1 mint of a big common trades like a ~$30–50 collectible *floor*, plus a modest premium that scales with the player.

This is why a multiplier-on-FMV model is structurally wrong for this cell: it multiplies a stable-ish absolute number by FMV, producing an estimate that grows ~linearly with FMV when the truth grows sub-linearly.

### Concrete failure cases (from the live board / handoff)
- **Jordan McLaughlin, Base Set COMMON #1/4099** — edition FMV $2.10, grid estimate **$110.35** (52.5×), ask $14 → board shows **−87.3%** (`coarse`). Quintile-3 reality: ~$39–46 realized. So $14 is a real deal, but the honest discount is **~65–70%**, not 87%.
- **Cade Cunningham, COMMON #1** (handoff) — grid est $118 vs a **~$25 realized** #1; ask $59 was *above* value. The flat multiplier turned an over-ask into a fake "50% deal." (This is why the guard now marks every COMMON #1 `coarse`, migration `audit_20260616_underpriced_board_estimate_quality_fix_common_no1`.)

## Proposed model — replace the COMMON-#1 multiplier with a floor + slope in absolute-price space

Recommended (Option A): for the **COMMON `first` cell only**, estimate the #1 price directly as

```
no1_estimate ≈ GREATEST(edition_fmv, FLOOR + SLOPE × edition_fmv)
```

A least-effort fit to the quintile medians (no1_price vs median_fmv) gives roughly **FLOOR ≈ $24, SLOPE ≈ 11** (line through ($0.86,$33) and ($7.61,$106)). Spot-checks against the table:

| edition FMV | model ($24 + 11×fmv) | observed median #1 | grid (52×) |
|---|---|---|---|
| $0.86 | $33 | $33 | $45 |
| $1.34 | $39 | $49.50 | $70 |
| $1.87 | $45 | $39 | $97 |
| $3.07 | $58 | $45 | $160 |
| $7.61 | $108 | $106 | $396 |

The model tracks the observed #1 price within normal sale noise across the whole FMV range, where the flat multiplier diverges badly above ~$2. Re-checking the named cases: McLaughlin (fmv $2.10) → **~$47** (honest −70% vs the $14 ask, still a strong deal); Cunningham reality ~$25 is within the floor band, so a $59 ask correctly reads as *not* a deal.

Coefficients above are a back-of-envelope fit to 5 medians — **the migration should re-fit FLOOR/SLOPE via a proper regression (or per-circ-band fit) on the full population at compute time**, not hard-code $24/11. The point of the proposal is the model *form* (absolute floor + slope), which the evidence strongly supports; the exact constants are a fitting detail to lock in review.

### Alternative considered (Option B): FMV-percentile multiplier damping
Keep the multiplier form but scale it down by the edition's FMV percentile within its `(tier, circ_band)` peer group (the handoff's original suggestion). This works but is a less natural fit — you're correcting a multiplicative model toward an additive truth, so it needs a steeper, noisier correction curve and is harder to reason about. Option A is simpler and more honest. (Option B is the right shape only if a future analysis shows the premium really is multiplicative for some sub-band.)

### Scope guard
- **COMMON `first` only.** Non-COMMON #1s (RARE 5.45×, LEGENDARY 2.56×) and all `perfect` mints (7.78×) have far smaller multipliers, so the absolute overstatement is small and they stay `tight` today. Do **not** touch them without the same per-cell validation.
- Keep the `GREATEST(edition_fmv, …)` floor (a #1 line must never read below the edition number).
- After the model lands, the `estimate_quality` guard for COMMON #1 can be relaxed from "always coarse" back to `tight` once the estimate is desirability-aware — that's a second, separate review step with its own acceptance test (below).

## Acceptance test (run before flipping COMMON #1 back to `tight`)
1. Re-run the quintile calibration above; the model's predicted #1 price should sit within ~±25% of the observed median in every quintile (the flat grid fails quintiles 3–5 by 2–4×).
2. On the live board, no COMMON #1 row should show a discount that implies a #1 value > ~1.5× the player-blind realized median for its FMV quintile.
3. Spot-check the two named cases resolve honestly: McLaughlin ~−70% (still a deal), Cunningham-class over-asks read as *not* deals.
4. Count how many of today's 16 `coarse` rows would become `tight` (informational — confirms the change is doing real work).

## Draft migration (NOT APPLIED — illustrative skeleton for review)
The real change is to how the COMMON-`first` branch in `serial_fmv_estimate` (and/or the upstream `serial_fmv_multipliers` recompute) produces its number. One clean shape: add a COMMON-`first` `(floor_usd, slope)` pair to a small config (or store it in `serial_fmv_multipliers` as two extra nullable columns on that cell), and special-case the branch:

```sql
-- ILLUSTRATIVE ONLY — do not apply. Re-fit FLOOR/SLOPE on live data in review.
-- In serial_fmv_estimate, replace the COMMON 'first' estimate line:
--   v_estimate := GREATEST(p_edition_fmv, p_edition_fmv * v_mult);
-- with, for the COMMON 'first' cell:
--   v_estimate := GREATEST(p_edition_fmv, v_floor + v_slope * p_edition_fmv);
-- where (v_floor, v_slope) come from a fitted COMMON-first row in serial_fmv_multipliers
-- (or a dedicated serial_fmv_no1_common_model config table), fitted by the same
-- recompute job that populates the grid today. All other (bucket, tier, band) cells
-- keep the existing multiplier path unchanged.
```

## Revert
Nothing to revert — this proposal applies nothing. If/when a migration is built and shipped, its revert is `CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(...)` back to the current body (captured in this repo's session history / `pg_get_functiondef` snapshot).

## Why this is paused here, not shipped
`serial_fmv_estimate` is FMV/pricing logic — explicitly off-limits for autonomous shipping. The board is already protecting users via the `coarse` label, so there's no urgency that would justify bypassing review. Hand this to Trevor (or run it through a reviewed migration session) to lock the FLOOR/SLOPE fit and the `estimate_quality` relaxation.

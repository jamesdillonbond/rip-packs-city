# FMV accuracy targets — held-wallet "confident but wrong" editions (2026-06-04)

> **CORRECTION (2026-06-04, per `docs/fmv-held-low-rootcause-2026-06-04.md`).** The set-218 inflation cluster below is mostly the **Step-6 "fossil" bug** (e.g. `218:7778` FMV $6.40 but max sale $0.75 — a WAP can't exceed its max, so it's a stale re-stamp), not a live WAP-outlier problem. The "ask as a clamp guardrail" idea is **wrong/dangerous**: `low_ask` is a floor, so a clamp false-positives on legit editions with lowball asks (`218:7826`: FMV $4.38 ≈ sales median $4.00, ask $0.34). Use the ask only to **flag** for review. Fixing Cause B (re-price from sales / stop fossil propagation) clears most of this cluster with no clamp false-positives.

Read-only diagnostic run in parallel while Claude Code worked the FMV-confidence handoff. Pairs with `docs/fmv-confidence-strategy-2026-06-04.md`. The point: before we raise *confidence*, make sure we're not confidently *wrong*.

## Finding 1 — HIGH/MED is already well-calibrated → the confidence push is accuracy-safe
For Top Shot editions held by the 243 active seeded wallets, latest FMV vs the live ask (`edition_offers.low_ask`, present for ~100%):

| confidence | held | median FMV/ask | >2x ask | >3x ask | <half ask |
|---|---|---|---|---|---|
| HIGH | 259 | 1.05 | 15 | 5 | 3 |
| MEDIUM | 623 | 1.07 | 63 | 32 | 14 |
| LOW | 6,405 | 0.85 | 713 | 387 | 927 |
| STALE | 195 | 0.89 | 44 | 25 | 23 |

HIGH/MED track the market (median ~1.05). Raising confidence via sales/ask agreement will not manufacture confident-wrong prices — divergent editions stay LOW.

## Finding 2 — one concentrated cluster: recent Base Set commons (mostly fossils)
~78 held MED/HIGH editions are priced >2x their live ask, concentrated in recent low-circ Base Set commons:

| setID | set | series | inflated MED/HIGH | avg FMV/ask | circ |
|---|---|---|---|---|---|
| 218 | Base Set | 8 (2025-26) | 28 | 7.3x | 4,099 |
| 90 | Base Set | 5 | 10 | 3.4x | 16,000 |
| 192 | WNBA 2025 | 7 | 7 | 2.3x | 3,000 |
| 124 | Base Set | 6 | 4 | 4.0x | 8,250 |
| 26 | Base Set | 2 | 4 | 4.3x | 31,750 |

Named examples (all MEDIUM/HIGH, showing in portfolios now):
- `218:7778` Neemias Queta Base Set COMMON — FMV $6.40 vs ask $0.32 (20x); max sale $0.75 → fossil (Cause B)
- `218:7492` Aaron Wiggins — FMV $4.85 vs $0.35 (14x)
- `174:5880` Shai Gilgeous-Alexander NBA Cup COMMON — FMV $16.40 vs $1.49 (11x)
- `218:7915` Adem Bona — HIGH $3.00 vs $0.35 (8.6x)
- counter-example (do NOT clamp): `218:7826` CJ McCollum — FMV $4.38 ≈ sales median $4.00, ask $0.34 (lowball floor) — FMV is correct
- inverse (undervalued): `26:673` Mason Plumlee — FMV $0.05 vs ask $0.75

Cause confirmed by CC: thin/stale GQL-path computations re-stamped fresh by Step 6, not live WAP outliers. The fix is the re-price (Cause B), not an ask clamp.

## Recommendation
Fix Cause B first. Use the live ask to **flag** editions where sales-WAP and ask disagree for review — never to clamp.

## Pre-change baseline (verify after CC ships)
- Held TS HIGH+MED: **882 (~10%)**; remeasure post-fix via the KPI view (treat ~39% as optimistic).
- Held TS MED/HIGH inflated >2x ask: **~78** (28 in set 218); target → near 0.
- KPI: `SELECT * FROM public.v_tracked_wallet_fmv_confidence;` (service_role); live artifact `rpc-tracked-fmv-confidence`.
- Spot-check wallet: `0xbd94cade097e50ac` via /insights/squeeze-check + portfolio FMV tile.

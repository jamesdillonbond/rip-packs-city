# Top Shot special-serial premium trends (2026-07-26)

EDA over the 1,791 modelable TS special-serial sales (serial #1 / perfect, on HIGH/MEDIUM-base editions,
last 3y). Premium = sale_price / base_fmv, expressed as a multiple (×). Feeds the pooled model
(`docs/models/topshot-pooled-serial-fmv-2026-07-26.md`). What shipped into the model from this pass:
recency weighting (v1.1.0) and the jersey-#1 double-special (v1.2.0); badges tested and rejected.

## Jersey number: the "double-special" (#1 serial of a player who wears #1)

**A serial #1 whose player's jersey is also 1 carries a real, distribution-wide premium.**

| bucket | #1 & jersey #1 | #1 & jersey ≠ 1 |
|---|---|---|
| all tiers | median **23.9×** (n=54) | 17.7× (n=894) |
| COMMON only (controlled) | median **51.8×**, p25 42.1 | 35.1×, p25 18.2 |

The COMMON-controlled cut is the honest read: not just outliers — the whole distribution shifts up (p25
42 vs 18). Fitted coefficient **×1.379**; CV med-APE on the affected editions improved 0.497 → 0.452.
**Shipped in v1.2.0** as the `jersey1` term (aggregate-neutral — ~54/1042 #1s — but sharpens the moments
collectors prize most). 711 TS editions have jersey #1. Applied only to serial #1 (not perfect).

## Badges: mostly redundant with set (NOT shipped)

First-serial premium by badge (`badge_editions` tags):

| badge | median #1 premium |
|---|---|
| Championship Year | **38.4×** (n=44) — the only clearly-premium badge |
| Top Shot Debut | 18.8× (n=133) ≈ no-badge |
| no premium badge | 18.6× (n=824) |
| Rookie (any) | 13.3× (n=99) — *below* baseline |

Adding badge flags to the model made it worse out-of-sample (set+badge 0.601 vs set-only 0.592). The reason
is visible in the set trends below: the premium lives in the **set** (`Rookie Debut` set 100× while the
`Rookie` *badge* is 13×; `Championship Year` clusters into premium sets). Set granularity dominates badge
granularity, so `set` already carries it.

## Player: stars command the biggest #1 premiums (informative, not modeled)

Top #1-premium players (n ≥ 4 #1 sales): Jayson Tatum 171×, Steph Curry 153×, Joel Embiid 107×,
Luka Dončić 106×, Anthony Davis 81×, Nikola Jokić 78×, Kevin Durant 65×, Giannis 45×, Wembanyama 42×.
Bottom: role players at 3–8×. The signal is real descriptively but **does not generalize forward under
time-CV** (star premiums are volatile / already priced into base FMV), which is why `player` stays unseeded
in the model — set absorbs the stable part.

## Set: the dominant, stable factor (this IS the model)

Top #1-premium sets (n ≥ 6): Crunch Time 158×, WNBA Rookie Debut 2024 123×, Rookie Debut 100×,
2024 NBA Playoffs 95×, Spotlight Series 64×, Extra Spice 51×, Playoffs commons ~44–50×.
Bottom: Holo Icon 3.3×, Rookie Revelation 2.7×, Top Script 1.25×. A ~125× spread across well-sampled sets —
the pooled model's 71 set effects encode exactly this, and it's why set-only beats the tier-coarse power-law.

## Takeaways for the model

1. **Set is the engine** — 125× spread, stable across time. Shipped (pooled model).
2. **Recency matters** — 180d-half-life weighting improved both median and mean error. Shipped (v1.1.0).
3. **Jersey #1 + serial #1 is a genuine scarcity-alignment premium** (×1.38). Shipped (v1.2.0).
4. **Badge and player are redundant with set / don't generalize** — tested, documented, not shipped.

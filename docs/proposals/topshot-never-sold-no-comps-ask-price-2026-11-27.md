# Top Shot: never-sold editions with no comparables are priced at 0.9 × ask (2026-11-27, Claude Code cloud)

**Status: APPROVED (Trevor 11-27: "Do all that makes sense") — migration WRITTEN, APPLY HELD.** `apply_migration` stopped for a confirmation that got no answer before the timeout (~10:30 AM PT); nothing was applied (table, trigger and migration row all absent, verified). The reviewed SQL is [topshot-never-sold-no-comps-ask-price-2026-11-27.migration.sql](topshot-never-sold-no-comps-ask-price-2026-11-27.migration.sql) — apply it under the name `audit_20261127_topshot_unsold_lu_tier_set_cap`, then commit it byte-exact to `supabase/migrations/<version>_…` and add the `_tiercap` note to `lib/fmv-basis.ts`.

**Chosen rule (point-in-time backtest, 72 Legendary/Ultimate plain-ask first sales):** never-sold L/U, no comparables, no offer pull → `least(price, greatest(median sale of the same tier + set (≥ 3 editions) else the tier's median first sale (≥ 5), 0.40 × price, best offer))`. MdAE 0.588 → 0.343, WAPE 0.933 → 0.480, published > 2× the sale 28 → 8 times; sale > 2× the new price 7 times (the 0.40 floor keeps that lower than the bare tier cap's 10). Dry run today: 88 editions lowered, $156k → $64k (e.g. Angel Reese 2024 WNBA Rookie Ultimates $8,999 → $3,600). Plus `topshot_ask_only_forward_test()`.

## What I measured (all against REAL first sales, never against FMV)

Top Shot ASK_ONLY prices scored against the next real sale, split by which rule set the price:

| population | n | median error (abs ln) | median bias (ln actual/published) | within ±25 % |
|---|---:|---:|---:|---:|
| first sale, price held to comparables (`_compcap`), since 11-13 | 24 | 0.119 | +0.07 | — |
| first sale, price pulled toward an offer (`_bidpull`), since 11-13 | 52 | 0.254 | +0.04 | — |
| next sale of an edition that HAD sold (relabelled ASK_ONLY after 30 days), since 11-14, non-L/U | 327 | 0.118 | 0.00 | 60 % |
| same, Legendary / Ultimate | 31 | 0.217 | −0.07 | 52 % |
| **first sale, plain ask (no comparables, no offer), never-sold L/U, last 150 days** | **34** | **~0.58** | **≈ −0.5 (sold at ~0.6× published)** | **~28 %** |

So the Top Shot ladder is in good shape **except one cell**: an edition that has never sold, has no set-comparable estimate (`fmv_comparable_estimates` `n_set < 3`), and has no open offer. It publishes 0.9 × the lowest ask, and those first sales came in at roughly 0.6 × that.

⚠ **The headline number I first got was misleading.** Pooled over 120 days, "plain ask" first sales looked like 515 cases at bias −0.59. 480 of those predate the 11-13 comparables/offer steps; after 11-13 only 35 were plain-ask. That is CLAUDE.md's "a rate pooled across a fix measures the fix's absence" — split on the change point before believing it.

## The live population today

112 never-sold, no-estimate, plain-ask editions, **$184k** of published value (avg ~$1,640): Holo Icon, 2026 NBA Finals, Rookie / WNBA Rookie Ultimates, Heroes of the Game: Diamond, Mojo, Signature Series, Skyline, Run It Back, plus a 17-edition **2023-24 Honors (RARE)** group up to $6,999 that looks like an ask outlier on its own.

## Options

1. **Leave it** — the forward evidence after 11-13 is 2 L/U first sales (both sold ABOVE the published price). Small n both ways.
2. **Haircut 0.9 → ~0.6 of ask for this one cell**, tagged `_nocomps` so `fmv-basis.ts` can say so. Backtest: fixes the median bias on the 34 historical cases; unknown out of sample.
3. **Tier-level comparables** for L/U (median first sale of never-before-sold editions in the same tier, last 180 days, ≥ 5) as a cap, the way Panini route 2 works — needs its own point-in-time backtest before shipping.

My recommendation: **3, then 2 as the fallback**, but only after a week of forward data — reuse the Panini pattern (a `*_forward_test()` function scoring first sales after a date) so the decision is made on post-11-13 sales, not the pooled history.

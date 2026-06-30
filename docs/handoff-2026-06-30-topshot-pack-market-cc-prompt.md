# Claude Code prompt — surface Top Shot secondary pack-market (2026-06-30)

Applied the Dapper Studio Platform pack-history pattern (memory `dapper-studio-platform-pack-history-api`) to **Top Shot**, the flagship. TS already had authoritative depletion (`topshot_pack_supply`), dist attribution, and realized/calibrated EV from the earlier pack-lifecycle program — so the *new* layer is the **complete secondary sealed-pack sales market** (what TS packs actually resell for). All DB objects live, `security_invoker`, anon-SELECT, security invariants 0. Frontend-only work below; direct to `main`, no PRs.

## What's newly available
- **`v_topshot_pack_market`** (per TS dist) — `n_sales`, `n_sales_30d/90d`, `last_sale_price`, `last_sale_at`, `avg_price_90d`, `median_price_90d`, `min_price_all`, `max_price_all`, **`secondary_vs_retail_ratio`** (median 90d ÷ retail), plus `title`, `drop_size`, `retail_price` (from `pack_ev_latest`), `depletion_pct` (from `topshot_pack_supply`). 154 dists now, growing as the backfill drains (see caveat). Live examples: "2026 NBA Finals Premium Pack" median $137 (650 minted, 60% depleted); "WNBA Rookie Debut" reselling 1.04× retail.
- Backing table `topshot_pack_sales_history` (complete TS pack sale history, draining from now → TS 2020 genesis; ~5k rows now → 562,733 total).

## Items to build (frontend)
1. **Secondary pack-market line on the TS dist/packs page.** From `v_topshot_pack_market`: "Sealed pack resale: median $X (90d) · last $Y · N sales" + premium/discount-vs-retail (`secondary_vs_retail_ratio`). Gate on `n_sales > 0`. This sits alongside the existing depletion + EV; it's the "what does the sealed pack itself trade for" signal Top Shot's own site doesn't surface cleanly. Cheap single-dist indexed read (`idx_ts_pack_sales_hist_dist`).
2. **`/insights/topshot-pack-market` board (high-value, flagship).** Rank TS packs by secondary signal: biggest resale premium, deepest discount-to-retail, most-traded, with drop size + depletion. Mirror the `/insights/allday-pack-market` board CC shipped (`c653e23`) — reuse its page/layout/OG/API/sitemap shape. Run `rpc-insights-qa`; gate `n_sales >= 5`.

## Data caveats
- **Backfill still draining (autonomous, self-terminating):** `topshot_pack_sales_history` walks sales newest→2020 (cron `rpc-topshot-pack-sales-backfill`, `*/3`, ~7h). So `v_topshot_pack_market` coverage + the `*_90d`/`min/max` windows deepen over the next few hours — design for "more history appears." `last_sale_at` is current; deep history lags.
- Prices are DUC ≈ USD; `purchased=true` rows only (completed sales). Premium packs have `retail_price` NULL (no fixed retail) → `secondary_vs_retail_ratio` NULL, fine — still show the absolute resale price.
- Do NOT rebuild TS depletion from this — `topshot_pack_supply` (getPackListing) is already authoritative and the market view already reads its `depletion_pct`.

## Revert reference
```
DROP VIEW public.v_topshot_pack_market;
DROP TABLE public.topshot_pack_sales_history; DROP TABLE public.topshot_pack_sales_cursor;
SELECT cron.unschedule('rpc-topshot-pack-sales-backfill');
-- Gated read-only edge fns (inert, reusable): backfill-topshot-pack-sales, probe-ts-pack-sales.
```

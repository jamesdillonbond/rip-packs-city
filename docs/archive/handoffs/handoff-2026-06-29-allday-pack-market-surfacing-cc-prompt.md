# Claude Code prompt — surface the complete AllDay pack intelligence layer (2026-06-29)

The AllDay pack **data layer is now comprehensive** — built via the Dapper Studio Platform GQL (complete sales + opens history, reachable from Supabase egress; full API ref in memory `dapper-studio-platform-pack-history-api`). Everything below is **live, security_invoker, anon-SELECT, security invariants 0**. This is the frontend work Cowork can't push. Direct to `main`, no PRs. The earlier 3 items (lifecycle strip, edition provenance, `/insights/allday-pack-reality`) already shipped (`bced12e`) — this is the *new* data on top.

## What's newly available (all per AllDay dist `dee28451-…`)

- **`v_allday_pack_market`** — secondary sealed-pack resale market per dist: `n_sales`, `n_sales_30d/90d`, `last_sale_price`, `last_sale_at`, `avg_price_90d`, `median_price_90d`, `min_price_all`, `max_price_all`, **`secondary_vs_retail_ratio`** (median 90d ÷ retail), plus `drop_size`, `retail_price`, `opened_pct_of_minted`. Sourced from `allday_pack_sales_history` (complete sale history, backfilling to AllDay's 2022 genesis).
- **`v_allday_pack_info`** — now also carries **authoritative complete depletion**: `opened_count`, `packnft_total`, `opened_pct_of_minted` (from Dapper `searchPackNft`, across ALL ~3,195 dists, ~94% avg open rate) — use THIS for AllDay depletion, it supersedes the rip-based `v_allday_pack_lifecycle.opened_pct_of_minted` (which only covers ingested opens). Also has corrected EV (`corrected_gross_ev`/`corrected_net_ev`/`low_confidence_ev`), already adopted on the dist page.
- **`v_allday_pack_realized_ev`** (45 dists) + **`v_allday_pack_lifecycle`** (realized pull value per dist) — from the earlier handoff, now populated (dist attribution is 100% via API).

## Items to build (frontend)

1. **Secondary pack-market line on the AllDay dist/packs page.** From `v_allday_pack_market`: show "Sealed pack resale: median $X (90d), last $Y, N sales" and the **premium/discount vs retail** (`secondary_vs_retail_ratio` — e.g. "Premium Guaranteed Hit retails $30, resells ~$14 = 0.47×"). Gate on `n_sales > 0`. This is genuinely novel — what a sealed pack actually trades for, which Top Shot's own site doesn't surface cleanly.

2. **Swap AllDay depletion to the authoritative source.** Wherever the AllDay packs/dist page shows depletion or "% opened", read `v_allday_pack_info.opened_pct_of_minted` (complete, all dists) instead of the rip-based lifecycle figure. The rip-based one is fine for the *realized-value* strip but undercounts opens.

3. **`/insights/allday-pack-market` board (new, optional but high-value).** Rank AllDay packs by secondary-market signal from `v_allday_pack_market`: biggest discount-to-retail, highest resale premium, most-traded, with drop size + depletion. Mirror the existing `/insights/*` surfaces; run the `rpc-insights-qa` checklist (sitemap, OG via `/api/og/*` route handler, param-stripped canonical, freshness chip from `max(last_sale_at)`, no hardcoded `#E03A2F`, drill-down to the dist page). Gate rows on `n_sales >= 5`.

## Data caveats (so sparse-but-growing rows aren't misread)
- **Backfills are still draining (autonomous, self-terminating):** `allday_pack_sales_history` is walking sales back to 2022 (~123k rows and climbing) and re-tagging each sale's `dist_id` (cron `rpc-allday-pack-sales-backfill`, `*/3`); `allday_pack_supply.opened_count` is filling across all dists (cron `rpc-allday-dist-opened-backfill`, `*/4`). So `v_allday_pack_market` (148 dists now) and authoritative depletion grow over the next few hours — design for "more dists appear," not a fixed set.
- `secondary_vs_retail_ratio` < 1 is common + real (most AllDay packs resell below the original $-retail; reward/airdrop packs have retail 0 → ratio NULL, fine).
- Prices are DUC ≈ USD. `purchased=true` rows only (completed sales).

## Platform-wide follow-up (not AllDay)
The same two queries (`searchPackMarketplaceHistory` + `searchPackNft`, filter by `nft_type`) backfill complete pack sales/opens history for **Top Shot** (`A.0b2a3299cc857e29.PackNFT.NFT`), Golazos, Pinnacle, UFC. Top Shot is the flagship and the highest-leverage next target — same edge-fn pattern as `backfill-allday-pack-sales`/`backfill-allday-dist-opened`.

## Revert reference (this session's DB objects)
```
DROP VIEW public.v_allday_pack_market;
ALTER TABLE public.allday_pack_supply DROP COLUMN opened_count, DROP COLUMN packnft_total, DROP COLUMN opened_updated_at;
ALTER TABLE public.allday_pack_sales_history DROP COLUMN dist_id, DROP COLUMN nft_status;  -- or DROP TABLE
SELECT cron.unschedule('rpc-allday-pack-sales-backfill');
SELECT cron.unschedule('rpc-allday-dist-opened-backfill');
SELECT cron.unschedule('rpc-allday-resolve-rip-dist-api');
-- v_allday_pack_info: revert to the pre-depletion def (drop the opened_* columns from the SELECT).
-- Gated read-only edge fns (inert, reusable): backfill-allday-pack-sales, backfill-allday-dist-opened,
--   resolve-allday-rip-dist-api, probe-allday-pack-history, probe-allday-packnft-agg, probe-sales-dist.
```

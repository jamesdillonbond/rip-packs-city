# AllDay pack full history — cracked via Dapper Studio Platform API (2026-06-29, Cowork)

Trevor: "get all sales and opening history on NFL All Day packs." Coverage was shallow (sales ~2 months back to 2026-04, opens ~2 weeks) because we only had the recent on-chain ingest window, and block-scanning AllDay's 2022 genesis (~100M+ blocks) is infeasible. **Solved via the Dapper Studio Platform GQL** — it has the complete historical pack record for every collection, reachable from Supabase egress (no proxy/secret). Full API reference in memory `dapper-studio-platform-pack-history-api`.

## The two sources (introspected + verified)

- **Pack SALES** — `searchPackMarketplaceHistory` → 1,150,438 pack txns all-products; AllDay filter `filters:[{base_filter:{nft_type:{eq:"A.e4cf4bdc1751c65d.PackNFT.NFT"}}}]`. Node gives `nft_id, sales_price`(/1e8 USD)`, purchased, receiver_address`(buyer)`, storefront_address, created_at{block_height,block_time,transaction_hash}`. All rows are completed sales.
- **Pack OPENS + dist** — `searchPackNft` (input `SearchPackNftsInput`; `PackNftFilter` has direct `id`/`dist_id`/`status` filters, no base_filter) → per pack: **`dist_id`, `status`(Opened/…), `nfts`(pulls), owner, burned_at**. This gives pack→dist *instantly* (no Mint-event scan) + opened-status.

## Shipped (live, draining autonomously)

1. **Complete pack SALES backfill.** Table `allday_pack_sales_history` (RLS on, anon-SELECT) + edge fn `backfill-allday-pack-sales` (cursored, gated) + cron `rpc-allday-pack-sales-backfill` (`*/3`, self-stops at `done`). Already 15.8k sales and walking back from now → 2022 (was 1,448 covering only 2 months). DUC price ÷1e8 = USD.
2. **100% dist attribution for opened packs** (replaces the infeasible block-scan). Edge fn `resolve-allday-rip-dist-api` + cron `rpc-allday-resolve-rip-dist-api` (`17 * * * *`) — looks up `searchPackNft` by pack `id`, writes `pack_rips.dist_id`. Attributed **232/232 rips → 48 dists** (was 3 gift packs). The block-scan `resolve-allday-pack-dist` cron is **unscheduled/retired**; `allday_mint_scan_state` is now moot.
3. **Per-dist boards now populate** with no view change: `v_allday_pack_lifecycle` (depletion, 40 dists w/ opens), `v_allday_pack_realized_ev` (modeled-vs-realized, 45 dists — e.g. "Rewind Chance" modeled $2.58 vs realized $40.86 = 15.8× sleeper). Security invariants 0.

## Follow-ups (not done — propose/decide)

- **Complete OPENS universe (full opening history + authoritative depletion).** Today's opens are the ~232 packs CC's on-chain ingester captured (recent). For *all* opened AllDay packs ever, paginate `searchPackNft` filtered to AllDay (by `dist_id IN (AllDay dists)` or `distribution` filter — PackNftFilter has no nft_type) into a durable `allday_pack` table (id, dist_id, status, owner, burned_at). Then per-dist depletion = opened/total across the full universe, not just tracked rips. `searchPackNftAggregation` likely gives per-dist status counts cheaply (no enumeration) — check it first.
- **Promote `allday_pack_sales_history` → product surfaces.** It's a standalone durable table (mirrors `allday_pack_supply`); wiring it into `pack_purchases`/analytics/pack pages is review-gated (shared worker-owned table + pricing-adjacent) — CC's call.
- **Platform-wide:** the same two queries backfill complete pack history for TopShot/Golazos/Pinnacle/UFC — just change `nft_type` (TopShot = `A.0b2a3299cc857e29.PackNFT.NFT`). Biggest leverage is TopShot (our flagship).

## Revert / cron reference
```
SELECT cron.unschedule('rpc-allday-pack-sales-backfill');
SELECT cron.unschedule('rpc-allday-resolve-rip-dist-api');
DROP TABLE public.allday_pack_sales_history; DROP TABLE public.allday_pack_sales_cursor;
-- pack_rips.dist_id fills are additive (safe to leave). Block-scan cron already unscheduled.
-- Gated read-only edge fns left for reuse: backfill-allday-pack-sales, resolve-allday-rip-dist-api,
--   probe-allday-pack-history. resolve-allday-pack-dist is retired (unscheduled).
```

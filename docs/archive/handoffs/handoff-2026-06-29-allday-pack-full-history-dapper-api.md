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

- **Complete per-dist depletion — SHIPPED.** Instead of enumerating millions of packs, used `searchPackNft(filters:[{dist_id:{eq:X},status:{eq:"Opened"}}], first:0).totalCount` = authoritative opened count per dist (e.g. dist 180 = 45,000/46,823 = 96%). Edge fn `backfill-allday-dist-opened` + cron `rpc-allday-dist-opened-backfill` (`*/4`) fills `allday_pack_supply.opened_count`/`packnft_total` for all ~3,195 dists (draining, avg ~94% open rate); surfaced as `v_allday_pack_info.opened_pct_of_minted` (complete catalog-wide depletion, supersedes the rip-based partial). Revert: `cron.unschedule('rpc-allday-dist-opened-backfill')` + the columns are additive.
- **Per-pack opening detail (optional, deeper):** if a pack-level open timeline (every opened pack id + when + pulls) is ever needed beyond the aggregate depletion, paginate `searchPackNft` (status=Opened, by dist) into a durable `allday_pack` table. Aggregate depletion above already answers "how many opened per dist."
- **Promote `allday_pack_sales_history` → product surfaces.** It's a standalone durable table (mirrors `allday_pack_supply`); wiring it into `pack_purchases`/analytics/pack pages is review-gated (shared worker-owned table + pricing-adjacent) — CC's call.
- **Platform-wide:** the same two queries backfill complete pack history for TopShot/Golazos/Pinnacle/UFC — just change `nft_type` (TopShot = `A.0b2a3299cc857e29.PackNFT.NFT`). Biggest leverage is TopShot (our flagship).

## Revert / cron reference
```
SELECT cron.unschedule('rpc-allday-pack-sales-backfill');
SELECT cron.unschedule('rpc-allday-resolve-r
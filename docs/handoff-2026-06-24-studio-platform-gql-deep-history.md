# Deep historical sales — BREAKTHROUGH: studio-platform GQL serves all collections (2026-06-24, CC)

**Status: discovery confirmed live + verified. Unblocks item #2 (deep historical tails) WITHOUT the spork-proxy or Trevor's Cloudflare creds.** This overturns the prior conclusion (in `app/api/cron/allday-sales-history-backfill/route.ts` and the open-cc-items handoff) that "AllDay marketplace GQL is DEAD." That test only hit `public-api.nflallday.com/graphql` (genuinely dead — nginx 404) and the CF-blocked consumer endpoint. It never tried the **Dapper studio-platform GQL**, which is alive, unauthenticated, and exposes deep per-edition sale history for every collection RPC indexes.

## The endpoint

`POST https://api.production.studio-platform.dapperlabs.com/graphql` — answers unauthenticated (no token, no `X-Proxy-Secret`). Verified from a residential IP 2026-06-24:
- `{__typename}` → `{"data":{"__typename":"Query"}}` (200)
- Full root-query introspection succeeds.

Root query fields include a `search<Collection>MarketplaceHistory` + `search<Collection>Nft` + `search<Collection>Editions` family for **every** RPC collection:
`searchAllDayMarketplaceHistory`, `searchGolazosMarketplaceHistory`, `searchPinnacleMarketplaceHistory`, `searchTopShotMarketplaceHistory`, `searchUFCMarketplaceHistory` (+ EPL, AthleteStudio, Seeds, Pack, Team/Seasonal variants), plus `searchAllDayEditions` / `searchGolazosEditions` / `searchPinnacleEditions`.

## Verified working query (AllDay) — copy/paste ready

```graphql
query H($in: SearchAllDayMarketplaceHistoryInput!) {
  searchAllDayMarketplaceHistory(searchInput: $in) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges { node {
      nft_id price sales_price purchased
      created_at { block_height block_time transaction_hash }
      nft { serial_number }
    } }
  }
}
```
Variables (filter by the AllDay edition flow id, which **is** `editions.external_id` for AllDay):
```json
{ "in": { "first": 50, "after": "<endCursor|omit>", "filters": [{ "edition_id": { "eq": 3206 } }] } }
```

**Live result for edition 3206** (2026-06-24): `totalCount: 8`, e.g.
```
nft_id 7667937 · price 334000000 ($3.34) · purchased true ·
created_at.block_height 122503919 · block_time 2025-08-10T16:34:50Z ·
transaction_hash 293538c1...8e88b · serial 3840
```

## Schema facts (introspected)

- `SearchAllDayMarketplaceHistoryInput` = `{ after: String, first: Int, filters: [AllDayMarketplaceHistoryFilter!], sortBy: MarketplaceHistorySort }`
- `AllDayMarketplaceHistoryFilter` = `{ base_filter: MarketplaceHistoryFilter, edition_id: UInt64Filter }`
- `UInt64Filter` = `{ eq, ne, gt, lt, gte, lte, in, notIn, exists }`
- Response `SearchAllDayMarketplaceHistoryResponse` = `{ edges [AllDayMarketplaceTransactionEdge], pageInfo: PageInfo, totalCount: Int }` (Relay-style; paginate with `first` + `after: endCursor` while `hasNextPage`).
- Node `AllDayMarketplaceTransaction` (sales-grade): `storefront_address, listing_resource_id, nft_type, nft_id, nft (AllDayNft), price, sales_price, purchased (Bool — true = completed sale), created_at/updated_at (BlockInfo), seller/receiver (UserDetails), commission_*, expiry, ...`
- `BlockInfo` = `{ block_height: UInt64, block_time: Time, event_index, transaction_hash: String, transaction_index }` → gives the **real Flow tx hash + height + timestamp** directly.
- `MarketplaceHistorySort` sorts by per-field `Sort` objects, e.g. `{ created_at: { ... }, price: { ... } }` (NOT a `{field,direction}` shape — that 422s). For backfill, no sort is needed (paginate the whole edition).

Other collections mirror this: filter type is `<Collection>MarketplaceHistoryFilter` with an `edition_id` (UInt64Filter) + `base_filter`; node/response are the analogous `<Collection>MarketplaceTransaction*`. Confirm each collection's node field names by introspecting `<Collection>MarketplaceTransaction` before building (UFC/Pinnacle may name the nft sub-object differently).

## Why this is the deep tail

`block_time` here is 2025-08 for this edition; for older editions it runs back to mint. There is no spork floor — studio-platform serves the full indexed history. `transaction_hash` is the real Flow hash, so inserts dedup cleanly against existing `sales` (same idempotency the TS/AllDay on-chain backfills use). `purchased: true` filters to completed sales (skip open/expired listings). `price`/`sales_price` are UInt64 DUC → **divide by 1e8** for USD ($334000000 → $3.34).

## Build plan (each its own verifiable step — no creds needed)

1. **Vercel egress check (the one open question).** studio-platform answered from a residential IP; confirm a Vercel function can reach it. If Vercel egress is blocked (like public-api.nflallday.com was), add a `/studio` route to the existing `topshot-proxy` worker (same pattern as `/allday` / `/allday-consumer`) and call through it. If reachable directly, no proxy needed. (Quick test: a tiny deployed route that POSTs `{__typename}` and logs status.)
2. **AllDay first (cleanest — `edition_id == external_id`, no UUID resolution).** Mirror `topshot-sales-history-backfill`'s safety rails (synchronous, ~200s self-budget, self-throttle, idempotent dedup by `transaction_hash`, `source='allday_studio_history_v1'`, one-DELETE revert). Per target edition: page `searchAllDayMarketplaceHistory(edition_id.eq=external_id)` while `hasNextPage`, keep `purchased:true`, write `sales` rows (edition_id known → zero edition creation, no mis-key risk) with `price_usd = price/1e8`, `sold_at = block_time`, `block_height`, `transaction_hash`, `serial_number`, `nft_id`. Seed the queue from AllDay editions (prioritize zero-sale ones — the existing `audit_20260624_allday_sales_history_backfill_targets` view already lists them).
3. **Golazos + Pinnacle** next (same shape; Pinnacle keys are `pinnacle_editions` — resolve the edition_id arg accordingly; introspect `searchPinnacleMarketplaceHistory` node/filter first).
4. **TopShot** is optional here — the existing `topshot-sales-history-backfill` already drains via the (different, also-live) public-api marketplace GQL; studio-platform is a fallback/cross-check.
5. Wire each as a low-cadence Vercel cron (off-rush), watchlist after 2 clean ticks.

## Note on the existing on-chain AllDay backfill
`allday-sales-history-backfill` (on-chain decode, 30k blocks/tick) stays valid for the current-spork-forward window and as the buyer/seller-address source. studio-platform is the **deep tail below the spork floor** (2021→2025-12-29) that the on-chain route can't reach. The two are complementary; dedup by `transaction_hash` means they can't double-write.

## Files / proof
Live introspection + query probes run from `node` (residential egress) using the project's environment. studio-platform requires no secret. The `dapper.market` public site 403s automation (WAF), so that specific lead is out — but studio-platform makes it moot.

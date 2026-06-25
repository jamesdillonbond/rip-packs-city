# Deep historical sales — BREAKTHROUGH: studio-platform GQL serves all collections (2026-06-24, CC)

> **STATUS 2026-06-24 (session 3): BUILT + LIVE for AllDay + Golazos + Pinnacle.** Vercel egress confirmed direct (no `/studio` proxy needed). Three drains shipped end-to-end — per-collection progress tables (RLS-on) + routes + `*/3` crons, live-verified (956 sales backfilled across 5 verification editions; AllDay→2023-06, Pinnacle→2024-12). UFC is **gated** (set-only filter + no `(set_id,edition_num)→edition` map; path forward in build step 3). Full record + revert paths: [docs/overnight/ledger.md](overnight/ledger.md) "2026-06-24 (session 3)". The build plan below is retained for reference.

**Status: discovery confirmed live + verified. Unblocks item #2 (deep historical tails) WITHOUT the spork-proxy or Trevor's Cloudflare creds.** This overturns the prior conclusion (in `app/api/cron/allday-sales-history-backfill/route.ts` and the open-cc-items handoff) that "AllDay marketplace GQL is DEAD." That test only hit `public-api.nflallday.com/graphql` (genuinely dead — nginx 404) and the CF-blocked consumer endpoint. It never tried the **Dapper studio-platform GQL**, which is alive, unauthenticated, and exposes deep per-edition sale history for every collection RPC indexes.

## ⚠ DEPTH CORRECTION (Cowork-verified live 2026-06-24) — read before building
The "runs back to mint / deep tail to 2021" claim below is **overstated** — it was extrapolated from one recent edition. Measured directly against studio-platform (9-edition spread across the AllDay timeline, same-origin browser POST):

| AllDay `edition_id` | series | studio-platform `totalCount` | studio oldest sale | our `sales` today |
|---|---|---|---|---|
| 1, 300 (2021 Genesis, Series 1) | 1 | **0** | — | 0 |
| 1500 | 4 | **185** | 2023-11-27 | 3 |
| 2200 | 5 | **125** | 2024-01-30 | 1 |
| 2900 | 6 | **107** | 2024-07-10 | 2 |
| 3206 | 7 | 8 | 2025-08-07 | 82 |
| 4000 | 8 | **32** | 2025-11-28 | 1 |

**What's true:** studio-platform has a **~2023-11 indexing floor for AllDay** (the Dapper "new marketplace"/Atlas era) — it does **NOT** contain AllDay's 2021–2023 launch history (Series-1 editions return `totalCount:0`). So this is **not** the pre-2021 deep tail.

**Why it's still a big win (build it anyway):** within 2023-11→present it massively **fills our coverage gap** — 185 sales where we have 3, 125 where we have 1. Our forward indexing only began meaningfully capturing AllDay in ~2026, so the entire 2023-11→2026 window is near-empty in our `sales`, and that's exactly the zero-sale-queue editions. This is the bulk of the *recoverable* AllDay history and it's high value — just scope it as **"2023-11 → present coverage backfill," not "to launch."**

**Yield estimate (Cowork-measured against our schema):** of the ~2,282 zero-sale AllDay editions, **~1,809 (~79%) fall in the fillable 2023-11+ window** (Series 3–10, incl. 1,116 zero-sale in the newest Series 9) and **~473 (~21%) are the pre-floor tail** (Series 1–2, 2021–2023) studio-platform can't reach. So a single AllDay drain backfills ~the large majority of the empty queue. The ~21% pre-floor tail is the on-chain-only slice to defer.

**Caveats for the build:** (a) some editions are deeper in our DB than studio-platform (edition 3206: ours 82 vs studio 8) — so this **augments, never replaces**; dedup by `transaction_hash` and keep both sources. (b) The pre-2023-11 tail (2021–2023 AllDay, and the equivalent early window for Golazos) is genuinely **only on-chain** (spork scan) — defer it as the low-priority slice, don't expect studio-platform to cover it. (c) Pinnacle (launched ~2024) and TopShot are likely fully within the studio-platform window, so the floor mainly bites AllDay/Golazos. Introspect each collection's actual oldest before assuming depth. (d) studio-platform rate-limits (~6 rapid calls → empties); throttle.

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

1. **Vercel egress — RESOLVED (Cowork-verified 2026-06-24): studio-platform is reachable DIRECTLY from Vercel egress, NO proxy needed.** This was the "one open question" — it's closed. The repo **already** calls `api.production.studio-platform.dapperlabs.com/graphql` directly from multiple deployed Vercel routes, and they're **green right now** in `pipeline_runs`: `pinnacle-metadata-backfill` 48/48 ok (last 00:22Z), `pinnacle-wmc-render-id` 48/48 ok (last 00:37Z), `pinnacle-catalog-backfill` 2/2 ok. The endpoint accepts unauthenticated requests **as long as an `Origin` header is sent**. Copy the proven, in-production header set from [`lib/packs/live-pack-listings.ts`](../lib/packs/live-pack-listings.ts):
   ```js
   const GRAPHQL_HEADERS = {
     "Content-Type": "application/json",
     "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
     Origin: "https://nbatopshot.com",
     Referer: "https://nbatopshot.com/",
   }
   ```
   **Reference implementations to copy (don't reinvent the fetch/pagination/logging):** `lib/packs/live-pack-listings.ts` (canonical studio-platform fetch + headers + Relay pagination) and `app/api/admin/backfill-pinnacle-catalog/route.ts` (paginated cursor drain against studio-platform with `pipeline_runs` logging + `Origin`-header gate — the exact skeleton an AllDay history-drain route needs). So the AllDay route = that Pinnacle-catalog skeleton + the `searchAllDayMarketplaceHistory` query above + the `allday_sales_history_backfill_targets` queue. **No `/studio` worker route, no new env var, no Trevor action.**
2. **AllDay first (cleanest — `edition_id == external_id`, no UUID resolution).** Mirror `topshot-sales-history-backfill`'s safety rails (synchronous, ~200s self-budget, self-throttle, idempotent dedup by `transaction_hash`, `source='allday_studio_history_v1'`, one-DELETE revert). Per target edition: page `searchAllDayMarketplaceHistory(edition_id.eq=external_id)` while `hasNextPage`, keep `purchased:true`, write `sales` rows (edition_id known → zero edition creation, no mis-key risk) with `price_usd = price/1e8`, `sold_at = block_time`, `block_height`, `transaction_hash`, `serial_number`, `nft_id`. Seed the queue from AllDay editions (prioritize zero-sale ones — the existing `audit_20260624_allday_sales_history_backfill_targets` view already lists them).
3. **Golazos + Pinnacle** next. **Per-collection filter key (Cowork-derived from our schema; Chrome was down so the GQL introspection itself is CC's last step):**
   - **Golazos** — `editions.external_id` is numeric (`"5"`, `"112"`), same shape as AllDay → almost certainly `edition_id == external_id`; `searchGolazosMarketplaceHistory` mirrors the AllDay query. Golazos launched ~2022-23 so expect the same ~2023-11 floor to bite its early editions.
   - **Pinnacle** — keyed by `render_id` in our schema (not a numeric edition id); the studio-platform filter is likely `render_id` or an edition-template id. Pinnacle launched ~2024 so it's **fully inside** the studio-platform window (no floor loss).
   - **UFC** — `editions.external_id` is a slug (no numeric edition id) — the **same id-gap as the UFC video issue**; CC must resolve a numeric `editionTemplateId` via `searchUFCEditions` introspection before the history query will filter.
   - **Introspection query CC should run** (same-origin on `api.production.studio-platform.dapperlabs.com/graphql`, or via a Vercel route with the proven `Origin` header) to confirm each filter/node shape before building: `query{ __type(name:"GolazosMarketplaceHistoryFilter"){ inputFields{ name type{ name kind ofType{ name } } } } }` (swap the type name per collection; also introspect `<Collection>MarketplaceTransaction` for the node's nft/serial sub-fields, which UFC/Pinnacle may name differently).
4. **TopShot** is optional here — the existing `topshot-sales-history-backfill` already drains via the (different, also-live) public-api marketplace GQL; studio-platform is a fallback/cross-check.
5. Wire each as a low-cadence Vercel cron (off-rush), watchlist after 2 clean ticks.

## Pre-flight (Cowork-verified 2026-06-24 — no DB blockers)
- `sales.source` is **free `text`, no CHECK constraint** → `source='allday_studio_history_v1'` inserts cleanly (no enum/constraint edit needed). Existing AllDay sources for reference: `flowty_archive_extractor, onchain, onchain_dapper_v1, onchain_dapper_v2`.
- **All 9 `sales_20XX` partitions carry a `transaction_hash` index** → the idempotent dedup the drain relies on is in place; re-runs and overlap with the on-chain route can't double-count.
- The distinct `source` value gives the clean revert: `DELETE FROM sales WHERE source='allday_studio_history_v1';`.
- Seed queue already live: `public.allday_sales_history_backfill_targets` (zero-sale editions, priority-ranked).

## Note on the existing on-chain AllDay backfill
`allday-sales-history-backfill` (on-chain decode, 30k blocks/tick) stays valid for the current-spork-forward window and as the buyer/seller-address source. studio-platform is the **deep tail below the spork floor** (2021→2025-12-29) that the on-chain route can't reach. The two are complementary; dedup by `transaction_hash` means they can't double-write.

## Files / proof
Live introspection + query probes run from `node` (residential egress) using the project's environment. studio-platform requires no secret. The `dapper.market` public site 403s automation (WAF), so that specific lead is out — but studio-platform makes it moot.

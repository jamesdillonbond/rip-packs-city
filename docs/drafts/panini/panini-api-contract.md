# Panini `/onepanini` — captured API contract (Plane A feed)

Captured 2026-06-27 from Trevor's logged-in session. This is the real feed contract the ingest keys off.
No secrets here — auth values were redacted at capture; only header *names* + the public query/response shapes are recorded.

## Transport + auth model

- **Endpoint:** `POST https://nft.paniniamerica.net/onepanini` — a single GraphQL gateway ("onepanini"); every
  operation POSTs here with `{operationName, query, variables}`.
- **Required headers:** `content-type: application/json`, `origin`/`referer` = `nft.paniniamerica.net`, `os: web`,
  `uuid: <stable per session/device>`, `authorization: Bearer <session token>`, `cookie: <session>`, and
  `signature: <per-request>`.
- **The `signature` is per-request and TIME-LIMITED.** Verified: two calls returned different signatures
  (`89eb9b6f…` vs `350acbc5…`), and `getPublicChainSettings.minutes_for_signature_expire = 15`. So it's a
  ~15-minute, body/time-derived MD5 — **not replayable, not worth forging.**
- **→ Architecture decision: logged-in residential headless browser.** A Playwright session on a residential
  runner (same pattern as `scripts/ingest-allday-badges.mjs` for AllDay Atlas / dapper.market) navigates the
  pack/edition pages; **the site's own JS computes the signature natively**; RPC hooks the `onepanini` responses
  and POSTs them to an ingest route. RPC never reproduces the signing and never holds the raw token in app code
  (the session lives only in the runner). Datacenter egress (Vercel/Supabase) is bot-walled (HTTP 426), which is
  why it must be the residential browser, not a proxy.

## Discovered operations

### 1. `getPublicChainSettings` — chain config + bridge contract
```graphql
query getPublicChainSettings { getPublicChainSettings { status message data {
  storage_fee_enabled fee_for_nft max_pool_limit remove_pool_limit no_of_nfts_per_txn
  minutes_for_signature_expire network_provider_active network_provider_down_msg user_otp_session_expire_in_mins
  networks { enabled image_url chain_type deeplink_url txn_explorer_base_url nft_explorer_base_url
    marketplaces { name image_url deeplink_url profile_deeplink_url nft_deeplink_url enabled } }
  verified_contract_addresses } } }
```
Key response values (2026-06-27): `verified_contract_addresses = ["0x23ae7a05f598fc234ee9dbef04033080dea8ab19"]`
(Ethereum mainnet bridge contract, OpenSea `paniniblockchain`); `minutes_for_signature_expire = 15`;
`network_provider_active = true`.

### 2. `getPackMarketStats(pack_id)` — pack composition + market + sealed count  ★ the pack-state plane
```graphql
query getPackMarketStats { getPackMarketStats(pack_id: "1038") { status data {
  pack_name release_year pack_img background_img
  pack_label { label children } sport cards_per_subpack pack_sku description total_pack_qty collection_name
  market_stats { top_sale avg_sale recent_sale floor_price unopen_pack_count pack_auction_count } } } }
```
WC2026 **Hobby** pack response (`pack_id "1038"`, referer `…/marketplace-details/subpack-5242848-1038.html`):
- `collection_name: "2026 Panini NFT Prizm World Cup Soccer"`, `cards_per_subpack: 4`, `pack_sku: "850141BC-PZM-WC-SOC-2"`.
- `total_pack_qty: 50480`, **`unopen_pack_count: 23482`** → **53.5% ripped** (matches tracker ~54% ✓).
- market: `floor_price 144 / recent_sale 146 / avg_sale 78.28 / top_sale 148 / pack_auction_count 845`.
- `pack_label` encodes the slot odds verbatim (2 Base Silver #/259 + 1 non-Silver #/124–1/1 + 1 non-Silver-or-35%-insert).

→ This single call per `pack_id` IS the pack-reality / "% packs ripped" / pack-floor surface. No derivation needed
(supersedes the Silver÷2 method in panini-methodology.md §1 — keep that only as a cross-check).

### 3. `getCardMarketStats(sku)` — per-edition market + ★ THE "still in packs" count
`getCardMarketStats(sku: "<psku>")` where psku = `packcard-<a>_<b>_<c>_<parallel>` (e.g.
`packcard-2332_486964_12579093_31`). Verified response (Désiré Doué, "Base Prizms Maple Leaf", cap /9):
- **`market_stats.unopened_pack_count`** = cards still sealed in packs — **the squeeze metric, per edition** (=1 here).
- `with_collectors_count` = pulled/owned (8); `for_sale_count` = listed (5); `burned_count` = 0.
- mint cap = `end_seq` (9). Reconciles: `with_collectors_count` 8 + `unopened_pack_count` 1 = 9 ✓.
- FMV inputs: `floor_price` 1500, `top_sale` 350, `avg_sale` 325, `recent_sale` 300, `volume_amount`/`volume_txns`,
  `unique_buyers`/`unique_sellers`, `avg_sale_label` ("lowball_offer").
- + `card_rarity`, `cardset`, `athlete`, image/video urls, `nft_views`, `unique_owners{…}`, `created_time`.

### 4. `getPskuTotalCardsList(psku, p, l, applied_filters, wallet_address)` — per-serial listings + special serials
Returns each individual serial of an edition: `sku` (`…__<serial>_<cap>`), `start_seq`/`end_seq`, `buy_now_price`,
`current_bid`, `owner` (username), `brought_at_price`/`brought_at_time`, `burned_count`/`is_burnable`, and
**`nft_type`** = `"number 1"` / `"jersey mint,perfect mint"` / null → maps straight onto RPC's **special-serials**
(#1 / jersey / perfect). Paginated via `p`/`l`; `applied_filters` mirrors the UI
(`minSerial/maxSerial/card_type/owner/listType/sortBy`).

### Field → RPC schema mapping
| Feed | RPC |
|---|---|
| `getCardMarketStats.unopened_pack_count` | `panini_editions.still_in_packs` — **store DIRECT** (supersedes the generated `mint_cap − pulled`) |
| `with_collectors_count` | `pulled_count` |
| `end_seq` | `mint_cap` |
| `for_sale_count`, `burned_count` | new columns (add to `panini_editions`) |
| `floor_price` / `top_sale` / `avg_sale` / `recent_sale` / `volume_*` | → `panini_fmv_snapshots` (FMV basis) |
| `athlete` / `cardset` / `card_rarity` | `player_name` / set+parallel / `rarity_label` |
| psku | `external_id` |
| `getPskuTotalCardsList.nft_type` (`number 1`/`jersey mint`/`perfect mint`) | special-serial flags |

**Schema refinement:** make `panini_editions.still_in_packs` a stored column fed by `unopened_pack_count` (not the
generated `mint_cap − pulled_count`), and add `for_sale_count` + `burned_count`. Update panini-schema.sql §1 at go-live.

## Status: Plane-A data discovery is COMPLETE
Every metric the community tracker shows — and more (live floor, special serials, burns, FMV basis) — comes from
**`getCardMarketStats` + `getPskuTotalCardsList` per edition** and **`getPackMarketStats` per pack**. Two small gaps:
1. **Enumeration:** the card-grid `onepanini` call on `/marketplace/nfts.html?…` that lists every edition `psku` in
   the set (so the runner knows what to fetch). One more capture, OR derive pskus from the catalog. Also the **FOTL
   pack_id** (Hobby = `1038`/50,480 confirmed; FOTL = id TBD / 13,960).
2. **The residential runner** (Trevor's logged-in session).

## Build order
1. Residential Playwright runner, logged in, hooks `onepanini`.
2. Walk: the grid query → every edition psku; `getCardMarketStats(psku)` → `panini_editions` (still_in_packs,
   pulled, floor, FMV); `getPskuTotalCardsList(psku)` → serial/special-serial layer; `getPackMarketStats(pack_id)` →
   `panini_pack_state`.
3. POST batches to a thin RPC ingest route (service-role writes; token stays on the runner).
4. Verify reconciliation (edition `with_collectors + unopened = cap`; pack `unopen/total` ≈ tracker ~54%); then the
   squeeze / pack-EV / FMV / special-serials surfaces all light up off real data.

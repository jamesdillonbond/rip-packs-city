<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## API contracts

### Top Shot GraphQL

> ⛔ **DECOMMISSIONED ~2026-08-28.** `public-api.nbatopshot.com` answers Cloudflare 530 / 1033 for every caller (residential included); the catalog walker, badge-set backfill and `resolve-and-associate` all fail on it, and the circulation field it fed now comes from the chain (`topshot-circulation-onchain`, 2026-09-03). Nothing below this line is a live contract — see `docs/operations/cron-schedule.md` for the dead-host census.

Endpoint: `https://public-api.nbatopshot.com/graphql`. Cloudflare blocks Vercel + Supabase egress, so all server-side calls must go through `topshot-proxy`. `marketplace/graphql` is also Cloudflare-blocked server-side — do not use.

- UUID editions: `searchEditions` via `topshot-proxy` (`bySetIDs` / `byPlayIDs`).
- Integer editions (`setID:playID`): Cadence `TopShot.getPlayMetaData(playID:UInt32)` + `getSetSeries(setID:UInt32)`.
- `topshotScore { points }` does NOT exist — causes 422. Use `tssPoints` as null placeholder.
- `listingOrderID` is the preferred field (shipped April 2026); fall back to `storefrontListingID`.

### NFL All Day GraphQL (two endpoints, non-overlapping schemas)

Cloudflare WAF on **both** hostnames blocks Vercel + Supabase egress, so both go through the topshot-proxy worker — but on different routes because the schemas don't overlap.

- `https://public-api.nflallday.com/graphql` — wallet/marketplace queries (`searchMomentNFTsV2`, `searchMarketplaceEditions`). Worker route `/allday`.
- `https://nflallday.com/consumer/graphql` — only endpoint that hosts `getMintedMoment(momentId)` and related per-moment lookups. Worker route `/allday-consumer` (added 2026-05-05). Same `X-Proxy-Secret`.
- Vercel routes that hit consumer/graphql directly (`lib/alldayGraphql.ts`, allday-wallet-search, allday-sets) work because Vercel egress isn't WAF-blocked there. Edge functions and other non-Vercel egress need the worker.

### Flowty API

POST `https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot`.
Required headers: `Origin: https://www.flowty.io`. `blockTimestamp` is in milliseconds. `valuations.blended.usdValue = LiveToken FMV equivalent`. 4 pages = 96 listings max. `buyUrl = https://www.flowty.io/listing/{listingResourceID}`.

All listing-cache routes use `flowty-proxy` Supabase edge function (Flowty blocks Vercel IPs). `cached_listings` upsert-then-conditional-purge, threshold = function-top `startedAt`. TS `onConflict: "flow_id"`. Flowty wins dedup on `flowId`.

### Flowty Pinnacle FMV floor issue (open)

Flowty Pinnacle emits uniform $1 floor across 10k+ listings (`upstream_floor_only=true`) — NOT a parser bug, real marketplace behavior. `cached_listings` ASK unreliable for Pinnacle until direct integration.

### Flow REST API scripts

Each argument must be `btoa(JSON.stringify({type, value}))` — NOT raw object. Response: `atob(raw.trim().replace(/^"|"$/g, ""))` → `JSON.parse`. `access(all)` required (not `pub`). Use `Buffer.from(str, 'utf8').toString('base64')` for Cadence encoding (NOT `btoa()` — breaks on Unicode).

### RPC FMV API

- `GET /api/fmv?edition={setID:playID}[&serial=N]`
- `POST /api/fmv` (batch, up to 100)
- `GET /api/fmv/demo` (public, no auth, 1hr cache, 5 real samples)
- Returns: `fmv, serialMult, badgePremiumPct, adjustedFmv, confidence, updatedAt`

⚠ **`serialMult` comes from `lib/fmv/serial-multiplier.ts` — a hardcoded step function — and there is a SECOND, empirically fitted serial-multiplier model that disagrees with it by ~3×.** `serial_fmv_multipliers` (per `tier × circ_band`, refit weekly) is what `serial_fmv_estimate` uses, and that is what prices a collector's PORTFOLIO (`get_wallet_moments_with_fmv`) and the underpriced-serials board. At the ALL/ALL roll-up: product API **12.0× / 4.5× / 3.0×** vs fitted **9.89× / 1.50× / 5.00×** for 1-of-1 / low / last-mint — and per cell the fitted model ranges 1.98–60× (first), 1.00–16.25× (low), 1.17–48× (perfect), so **a LEGENDARY/ultra #1 fits at 2.17× against the API's flat 12×**. Neither is obviously wrong; **the defect is that both exist under one name with nothing recording which is authoritative** (Trevor's call — filed, not taken). ⚠ **Do not "fix" the homepage copy against the fitted table** — `HomePageMarketing.tsx:145` accurately states the API's model, and a deep audit's P2 recommending otherwise was disproved 2026-08-15 (see Known issues #18). ⚠ A THIRD set, `applySerialPremium`'s 1.35/1.18/1.2, is deliberately separate — see `lib/serials/fun-patterns.ts` under "Key files".

⚠ **`/api/fmv` evaluates the curve at a FABRICATED circulation: `serialMultiplier(serial, 1000)`, and the route never selects `circulation_count`.** So the documented `lastMint: 3x` fires only on editions whose circulation is exactly 1000, and the ordinary-serial tail scores every serial against a denominator of 1000 (anything >1000 clamps to exactly 1.0×). Serials 1 / ≤10 / ≤23 short-circuit before `circ` is read and are unaffected — which is why this stayed invisible, since the headline cases are all correct. Fixing it changes `serialMult`/`adjustedFmv` for every non-banded serial on the documented product API, so it is a PRICING change, not a bug fix in place.

⚠ **`/api/fmv/demo` must call the real multiplier, never its own copy (fixed 2026-08-15).** It carried a fork whose tail had drifted to `max(1, (circ/2/serial)^0.4)` against the real `1 + 0.08·max(0, 1 − serial/circ)` — so the public, no-auth surface whose entire purpose is to show a developer what the API does published **1.90× for serial 100 of a /1000 edition where `/api/fmv` returns 1.07×**, a ~77% overstatement, in both its sample numbers and its published formula string. **A demo that does not call the real code path is a second implementation and will drift again**; it now imports the shared module and `__tests__/api-fmv-demo-docs-match-implementation.test.ts` derives the documented breakpoints FROM that module, so the published spec cannot diverge from the code. That guard **strips comments before matching** (the file's own header quotes the old formula to explain the fix) — the recurring rule for any check that greps source for user-visible text.

---

## Sniper feed specifics

File: `app/api/sniper-feed/route.ts`

- Merges Top Shot GQL + Flowty listings.
- Parallel TS fetches with 6s `withTimeout()`.
- Dedup by `flowId`; Flowty wins on conflict.
- Sort by `updatedAt desc`, 200 max.
- `SniperDeal` has `source: "topshot" | "flowty"`.
- Flowty FMV fallback to Supabase when LiveToken null/zero.
- Retired moments excluded.
- `tsCount: 0` on every call = Top Shot proxy returning empty/auth-rejected; check worker reachability and `X-Proxy-Secret` ↔ `PROXY_SECRET` alignment.

---

## Flow/Cadence contract addresses

- Dapper merchant: `0xc1e4f4f4c4257510`
- DUC payment: `0xead892083b3e2c6c` (NOT `0x82ec283f88a62e65` — that was an older alias)
- **NFTStorefront V1 (Dapper, native AllDay/Golazos/UFC marketplace): `A.4eb8a10cb9f87357.NFTStorefront`** (no V2 suffix) — primary path discovered 2026-05-18
- NFTStorefrontV2 (Dapper, TopShot PackNFT / Pinnacle / MFL packs only): `A.4eb8a10cb9f87357.NFTStorefrontV2`
- NFTStorefrontV2 (Flowty fork, dormant since 2026-05-14): `A.3cdbb3d569211ff3.NFTStorefrontV2`
- NonFungibleToken + MetadataViews: `0x1d7e57aa55817448`
- FungibleToken: `0xf233dcee88fe0abe`
- HybridCustody: `0xd8a7e05a7ac670c0`
- DapperOffersV2: `0xb8ea91944fd51c43`
- NFL All Day: `0xe4cf4bdc1751c65d`
- AllDay/Golazos/UFC trade contract (buyer = contract addr): `0xedf9df96c92f4595`
- Disney Pinnacle: `0xedf9df96c92f4595`
  - Events used: `Pinnacle.PinNFTMinted` (mint marker) · `Pinnacle.Deposit {id, to: Address?}` · `Pinnacle.Withdraw {id, from: Address?}`. ⚠ **`Pinnacle.NFTListed` DOES NOT EXIST** — listings come from the storefront (`A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable`); see `workers/pinnacle-events-proxy`. A peer-to-peer TRADE emits Withdraw+Deposit and NOTHING else: no storefront event, no mint event (see `docs/reference/database.md` → "Disney Pinnacle has THREE transaction types").
- DapperStorageRent: `0xa08e88e23f332538` (reference only — no longer imported by any script since the storefront-cleanup machinery was removed, Known issues #9; the other 10 addresses above are all actively referenced in code, verified 2026-07-16)

### Cadence service payer wallet (displaced VERBATIM from CLAUDE.md 2026-08-24 to pay for a new rule there)

- Cadence service payer wallet: `0x73f55c4450b8d466` — gas payer for backend-submitted Cadence transactions, distinct from the hot wallet. Intentionally empty and its balance-check cron is paused while all Cadence-write features are shelved.

### Cadence purchase transaction rules

- Must be Cadence 1.0 syntax: `auth(BorrowValue) &Account` — NOT `AuthAccount`.
- Dual-signer required: Dapper co-signer + buyer.
- DUC leak check in `post{}` block required by Dapper co-signer.

### Per-collection Cadence gotchas

- **TopShot**: `TopShot.QuerySetData` exposes only `setID/name/series` — no `tier` field. Tier must come from GQL or per-NFT MetadataViews.
- **AllDay**: `borrowMomentNFT` DOES exist on `&AllDay.Collection` (concrete type at `/public/AllDayNFTCollection`) — prefer it over the generic `borrowNFT(id)! as! &AllDay.NFT` cast since the typed return directly exposes `editionID / serialNumber / mintingDate`. For V2 Flowty fork sales, `buyer` field on the event payload is the Flowty fee router (`0x3cdbb3d569211ff3`) not the real buyer — recover via `fetchTxBuyers` (proposer/authorizers/payer minus EXCLUDED_ADDRESSES). For V1 Dapper sales, the real buyer comes from `A.e4cf4bdc1751c65d.AllDay.Deposit.to`; do NOT rely on the contract address parenthetical.
- **Pinnacle**: borrow plain `&{NonFungibleToken.Collection}`, call `borrowNFT(id)`, pass NFT ref directly to `MetadataViews.getTraits/getEditions`. `MetadataViews.ResolverCollection` is NOT exposed at the standard MetadataViews address for Pinnacle.
- **UFC**: Import `UFC_NFT` only for `CollectionPublicPath`; borrow as generic `NonFungibleToken.CollectionPublic` + `borrowNFT(id)!` force-unwrap. `Traits` FAILS (AnyStruct `.toString()`). Fighter from edition name split `"|"`. 0% series characteristic.

---

## Cadence Work

The Flow Claude Code Plugin (`onflow/flow-ai-tools`) is installed and provides 11 specialist skills plus a Cadence MCP server.

Before modifying any `.cdc` file, any string literal containing Cadence (notably files in `lib/cadence/` and any inline `cadence` template literal in `app/api` routes), or any FCL `mutate` or `query` call, the Cadence MCP must be used to fetch the source of the relevant deployed contract on Flow mainnet and verify that the functions, fields, structs, and argument types being called actually exist on chain. Do not rely on training-data assumptions about Cadence APIs — they are frequently wrong for Cadence 1.0.

The canonical list of mistakes this verification step is meant to prevent lives in the **Per-collection Cadence gotchas** section above. Do not duplicate those bullets here — refer back to them.

The Cadence MCP is for development-time verification only. All production reads must continue to route through the existing proxy layer (Cloudflare Workers `topshot-proxy`, `spork-proxy`, `allday-proxy`, `pinnacle-proxy`, `hybrid-custody-proxy`, `reddit-proxy`, `rpc-sports-proxy` on `tdillonbond.workers.dev`, plus the `flowty-proxy` Supabase edge function) because Flow public endpoints and the Top Shot and Flowty APIs all block Vercel egress IPs at the edge. Never suggest replacing a worker-proxied route handler with a direct call to `rest-mainnet.onflow.org`, `public-api.nbatopshot.com`, or `api2.flowty.io`.

When onboarding a new collection or building the planned Pinnacle direct integration, fetch the live contract source via the Cadence MCP first and verify struct fields against the actual deployment before writing the script.

---


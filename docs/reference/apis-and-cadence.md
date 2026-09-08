<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## 2026-09-03/04 — Top Shot is readable ON CHAIN, and the Flow REST script has a MEASURED batch ceiling

With `public-api.nbatopshot.com` decommissioned, two Top Shot facts that the GraphQL host used to serve
are on chain and reachable from anywhere (Supabase edge fns and Vercel both hit `rest-mainnet.onflow.org`):

- **serial** — `getAccount(holder).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)`
  then `borrowMoment(id:)` -> `.data.serialNumber` (also `.data.setID` / `.data.playID`). ⚠ The public
  capability is the INTERFACE type, not `&TopShot.Collection`. Verified on mainnet 2026-09-03:
  `52356781 @ 0x3795d42c0fc3a373 -> 41`; `52676253 @ 0xab2277611893d945 -> 15`.
- **circulation / retired** — `TopShot.getNumMomentsInEdition(setID:playID:)` and
  `TopShot.isEditionRetired(setID:playID:)`. ⚠ `isEditionRetired` returns `Bool?` and `Bool` has **no
  `.toString()`** in Cadence 1.0 — use a ternary. A nil `getNumMomentsInEdition` means the pair is not an
  edition on chain; the batch script below encodes that as the sentinel `4294967295`.

🚨 **MEASURED BATCH CEILING — a 250-pair script is HTTP 400 (Flow error 1110, computation limit).**
Each pair is two contract calls. Probed from Trevor's box 2026-09-04: **250 -> 400, 100 -> 400,
50 -> 200 (393 ms), 25 -> 200**. `topshot-circulation-onchain` ships **40** pairs per script (~239 calls
for the 9,523-row base population, ~90 s total). ⚠ The first production tick shipped at 250 and lost 38
of 39 calls — read the ERROR BODY, not just the status: the body names the Flow error code.

⚠ **`npm run test:cadence` does NOT walk `supabase/functions/**`.** `scripts/extract-cadence.mjs` covers
inline Cadence in `app/` and `lib/` only, so a script embedded in an EDGE FUNCTION (or in a route added
after the extractor was written) is unlinted and a green gate says nothing about it. **Verify by
EXECUTING it on mainnet through the Cadence MCP** with a row the function will really process, and record
the input/output pair in the function header. ⚠ MCP script args are plain strings in an array
(`["0x…", "52356781"]`), NOT the `"Address:0x…"` form.

## API contracts

### Atlas — THE live Top Shot / All Day source (2026-09-06)

⚠ **Measured 09-07:** `{product, editionId}` with no `completed` key returns the edition's **FULL transaction history** newest-first (listings open, sold AND cancelled — `completed:true, purchased:false` is a cancellation), paginated at 200 — it is NOT an open book. To verify one listing is still open, read `{product, nftId}` (that Moment's history, a handful of rows) and let the drain's upsert flip `completed`. `sync_ts_listings_from_atlas` / `atlas_listing_verify_dispatch` do exactly this.

`https://api.production.atlas.dapperlabs.com/public/atlas.v1.<Service>/<Method>` — the Connect-RPC backend
nbatopshot.com and nflallday.com themselves call. POST JSON; headers `content-type: application/json`,
`connect-protocol-version: 1`, `origin`/`referer` = the product site, a browser UA (`atlas_market_headers(p)`).
**Unauthenticated.** ⚠ **Reachable from Supabase pg_net ONLY** — Vercel and Cloudflare Workers are
WAF-blocked (known-issues #20), so every read is DB-side; from Next.js use `lib/chains/flow/atlas.ts`.

| method | body | answers |
|---|---|---|
| `MarketplaceService/SearchMarketplaceTransactions` | `{product:'nba'\|'nfl', limit≤200, offset}` | the platform-wide FIREHOSE, newest `listedAt` first: listings (`completed=false`), sales (`completed`+`purchased`, `purchasedAt`, buyer+seller, `marketplaceFeeCents`, `sellerProceedsCents`), offers (`offerType` EDITION\|PARALLEL\|SERIAL, `buyerAddress`), filled offers. ~4–7 events/min on nba (a dated sample). |
| same | `+ {editionId}` | that edition's OPEN listings, price ascending, with serial + nftId + seller (= the site's Listings tab) |
| same | `+ {editionId, completed:true}` | that edition's sales history |
| same | `+ {nftId}` | one Moment's listing + sale history — the verification-by-listing check |
| same | `+ {sellerAddress}` | a wallet's listings (0x optional) |
| `ProfileService/SearchUserProfiles` | `{product:'nba', username}` | `userProfiles[0].flowAddress` (+ `username`, `profileImageUrl`, `favoriteTeamIds`, `createdAt`); `flow_addresses` is the reverse lookup |
| `EditionService/SearchEditions` | `{product, setId:[…], limit, offset}` | the edition catalogue (the badge lane, `atlas_editions_*`) |

⚠ **Unknown keys are IGNORED, no error** — a misspelled filter silently returns the firehose; assert on the
answer's shape, never on the request having been accepted. Pagination: `pagination.hasMore`.

**What is built on it (migration `20260906203504`):** `topshot_atlas_market_events` (one row per Atlas
uuid, both products, anon-readable) fed by `atlas_market_dispatch()` / `atlas_market_drain()` on pg_cron
every 2 min (pipeline `atlas-market-feed`), and the two-phase RPCs `atlas_resolve_username_{begin,collect}`
/ `atlas_verify_listing_{begin,collect}` (service_role). ⚠ **Delistings are NOT in the firehose** — a
listing that vanishes without a sale is only seen by re-reading `{editionId}`; open-listing truth for the
sniper needs a per-edition refresher, not the firehose alone.

🚨 **pg_net SENDS ONLY AFTER THE ENQUEUING TRANSACTION COMMITS** (measured 09-06: a request posted and
polled inside one transaction is never answered and rolls back with it — a migration's in-transaction
positive control timed out on a call that answers in 4 s from `execute_sql`). A "synchronous" post+await
function is structurally impossible; every live read is TWO rpc() calls, and a migration cannot prove an
Atlas read — verify after apply.

⚠ **Probing from a session? RECORD THE REQUEST ID** in `topshot_atlas_market_requests` (`product`, `offset_at -1`,
`drained_at now()`, `error '__probe__ <what>'`) — the 403 arm attributes by that join, and an unrecorded probe
pages as an unknown edge-function failure (CRITICAL) for two hours. **All Day:** `{product:'nfl', nftId}` returns
the edition (`editionId` = our `editions.external_id`, exact) + serial for ANY holder state — the ownerless read
the unmapped-sales resolver never had (`allday_resolve_unmapped_via_atlas`, 20260906214103).

⚠ **Cloudflare's managed challenge on this egress is BURST-SENSITIVE.** Base rate on the badge lane
~5–15 % `403 Just a moment…` (independent singles); a 60-request A/B burst pushed it to **100 % for ~4 min**
and every header variant (browser UA, honest UA, no origin, bare) 403'd identically — from this egress the
challenge is rate-shaped, not header-shaped. Total Atlas traffic today ≈ 5 req/min (editions + market);
never probe in bursts, and read `topshot_atlas_market_requests.error` before blaming the code.

### 🚨 Counterparty source floors — where each upstream BOTTOMS OUT (measured 2026-09-07/08)

⚠ **Every source for `sales.seller_address` / `buyer_address` has a floor, and three of the four floors
are INVISIBLE at the call site** — they answer 200, or an empty result, not an error. Filling a
counterparty gap means picking the source whose floor is BELOW the era you want; there is no source that
covers everything, and one era is covered by nothing at all.

| source | floor | collections | how the floor presents |
|---|---|---|---|
| **Flow REST** `/v1/transaction_results` | **2023-11-08 17:00Z** (spork wall) | all | ⛔ **HTTP 200 with an empty body** (`execution: "Pending"`, zero events) — `res.ok` is not a liveness check; discriminate on the BODY |
| **Atlas** `SearchMarketplaceTransactions` | **~2021-01** for completed purchases | **`nba` + `nfl` ONLY** | an unsupported product is a hard **`400 invalid_argument "product is required"`** — ⚠ NOT the silent-firehose fallback an unknown *key* produces |
| **Dune** saved query `8027085` | **~2021** — returns **zero rows** below it | **`nba_top_shot` ONLY** | ⛔ **`rows_returned: 0` on a 200** — a successful execution of an empty result, indistinguishable from "no sales that week" unless you know the window has rows |
| **`flowty_transactions`** | n/a | all | ⛔ **carries no counterparties at all** — `payer` / `proposer` / `storefront_addr` are not buyer/seller |

**Consequences, each of which someone has already assumed the other way:**

- ⛔ **2020 Top Shot counterparties are PERMANENTLY UNRECOVERABLE** — 79,160 sales (oldest 2020-07-28),
  0.0 % seller coverage, below every floor above. **Do not spend money or a cycle trying to recover them**,
  and do not let a surface imply provenance for that era. Measured 2026-09-08: ten clean Dune windows over
  2020-11-27..2020-12-17 returned `rows_returned: 0` on every one; 9 Atlas probes across Moments carrying
  2020 sales returned **zero** 2020 purchase records (oldest Atlas purchase seen anywhere **2021-01-15**).
- ⚠ **Atlas is the DEFAULT for 2021→now, not Dune** — it serves ~699,169 of the 909,970 below-wall
  nba_top_shot null-seller rows for free, with both counterparties, and the chains are coherent (each
  sale's buyer is the next sale's seller). Anything that pays for that era is paying for free data.
- ⚠ **UFC Strike + Golazos have NO counterparty source below the wall** (778,032 rows) — Atlas rejects both
  products, Flow REST is pruned, Flowty has no counterparties. ⚠ **But `ufc_strike` is a CLOSED market**
  (`collections.market_closed_at = 2026-05-13`, FMV frozen, UI renders unavailable), so 702,545 of that
  would buy history for a dead collection — **size the value before the volume.**
- ⚠ **`claim_sales_counterparty_batch` covers `nba_top_shot`, `nfl_all_day`, `ufc_strike` only** — Golazos
  is NOT in its `IN` list, and it is floored at the spork wall. It excludes two sources as known-undecodable
  (`allday_studio_history_v1`, `ufc_studio_history_v1`).
  ⛔ **Golazos's omission is CORRECT, not an oversight — do not "fix" it** (a 2026-09-08 filing called it a
  real gap; that was wrong). **99.4 % of `laliga_golazos` sales are `golazos_studio_history_v1`** (78,073 of
  78,553, **zero sellers**), and 2 of 2 sampled hashes from it resolve to **LISTING** transactions —
  `NFTStorefrontV2.ListingAvailable` plus fee movements, **no NFT `Withdraw` event**, so there is no
  counterparty to decode. Same family as the two named exclusions (`ufc_studio_history_v1` 813,380 rows /
  **0** sellers). Golazos's only decodable rows are its 480 on-chain ones (`onchain_dapper_v2` 378 +
  `onchain` 102), already **100 %** filled. ⚠ **The `*_studio_history_v1` hash appears to be the LISTING tx,
  not the purchase tx — n=2, re-derive before acting.** The rows are not duplicated (78,073 rows : 78,073
  distinct hashes, 1.45 rows per nft), so they read as genuine sales carrying an unusable hash.
- ⚠ **Dune returns FAR more sales than `sales` holds** — 38,105 rows for a 2023-06 week in which `sales`
  carries ~8,358 Top Shot rows. That is the *ingest* gap, not a counterparty gap, and a fill-only lane
  (`apply_sales_counterparty_external`) can never close it: it matches `(transaction_hash, nft_id)` on rows
  that already exist and **cannot create a row**.

⚠ **A single failed execution is not a diagnosis.** The first 2020 probe returned Dune
`QUERY_STATE_FAILED` and was read as an era/schema fault; the same era ran clean an hour later and simply
returned nothing. Re-run before concluding — and prefer a control window in a DENSE period, or a legitimate
zero (2020-07 carries 266 rows all month) reads exactly like "this source cannot serve the era".


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


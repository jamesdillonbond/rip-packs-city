<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## ⭐ DUNE'S `flow.cadence_events` IS THE INDEPENDENT CONTROL FOR ANY "IS OUR INGEST MISSING ROWS?" QUESTION (method, 2026-09-11, register #70)

When a collection's volume falls, **nothing inside this estate can tell a market decline from a
coverage gap** — `rows_found` is what *our* query returned, so a narrowing upstream looks identical to
a quiet market. **Dune is built from the chain and touches none of our pipelines**, which is what
makes it a control rather than a second opinion. Total cost of the 09-11 investigation: **~2 credits
of 2,500** — it is cheap, and the constraint is datapoints (rows × columns), not queries.

**The method, in the order that worked. Steps 1–3 each changed the answer.**

1. **Read the event types FROM the chain — never guess them.** `UNNEST(topics)` filtered to
   `%<Contract>%` over 2–3 days. All Day emits only `Deposit` / `Withdraw` — **no sale event of its
   own**, which a guessed query would have missed entirely.
2. **Find the marketplace by CO-OCCURRENCE, not by assumption.** Take the transactions containing the
   collection's `Withdraw` and group the *other* topics in the same tx. That surfaced
   `NFTStorefrontV2.ListingCompleted`, `NFTStorefront.ListingCompleted`, `OffersV2.OfferCompleted` and
   `PackNFT.Opened` together.
3. **Read one sample `data` payload before counting anything.** It is JSON carrying `nftType`,
   `purchased`, `salePrice`, `nftId` — so a collection filter and a cancellation filter are both
   available **without joining on transactions at all**. ⚠ **`ListingCompleted` fires on
   CANCELLATION too**: 09-07 had **629 cancels against 272 purchases**, so counting the event raw
   manufactures a coverage gap that does not exist.
4. **Always filter `block_date`** (the partition column), or the cost climbs fast.

**Calibration — how good the comparison can get.** Purchased-listing counts matched RPC's own `sales`
**EXACTLY on 27 of 30 days** (398/398, 841/841, 984/984); the three misses were one partial-window day
and two off-by-2s. ⭐ **That exactness is itself a finding instrument — once the listing path matches
perfectly, anything else is provably ABSENT.** That is how the missing All Day accepted-offer lane
surfaced: Top Shot has `offer_fill` at 9,260 rows/14d, All Day has **none**, at roughly **65/day**.
(Sized afterwards, it is worth **+0.15–0.58 points of M2** — only 450 of 2,190 fills are mappable, and
the naive ×4.87 scale-up is an upper bound because the mappable subset is biased toward
already-traded editions.)

**Gotchas**

- It counts **EVENTS**, so a multi-moment transaction contributes one row per moment — comparable to
  `sales` **rows**, not to transaction counts.
- Addresses seen in this pass: AllDay `e4cf4bdc1751c65d` · TopShot `0b2a3299cc857e29` ·
  storefront `4eb8a10cb9f87357` · OffersV2 `b8ea91944fd51c43` (serves **both** AllDay and TopShot) ·
  DUC `ead892083b3e2c6c`.
- A large result exceeds the MCP output cap and is written to a file instead — **parse it with a
  script**, do not read it into context.

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

⛔ **RETIRED 2026-10-03 (R99): `npm run test:cadence`, `scripts/extract-cadence.mjs` and the `Cadence lint` CI job were deleted with the dead purchase/offer templates — NOTHING lints inline Cadence now; verify against mainnet per the MCP rule.** Historical: ⚠ **`npm run test:cadence` does NOT walk `supabase/functions/**`.** `scripts/extract-cadence.mjs` covers
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

🚨 **2026-09-19 — CLOUDFLARE BOT MANAGEMENT NOW CHALLENGES curl/Node ON `SearchMarketplaceTransactions`, INCLUDING FROM A RESIDENTIAL IP.** Until 09-18 the rule was "datacenter blocked, residential curl fine" and two arms lived on it (the GitHub runner's pre-probe and Trevor's Windows Task Scheduler). The night of 09-18 both began receiving `403` + `<title>Just a moment...</title>` (a JS challenge, `__cf_bm` set, never cleared for a non-browser client) — measured from the GitHub runner (3 skips), the laptop VM on the residential IP (curl, repeatedly), and Playwright's Node-side `request` context even WITH a browser's cookies. **pg_net from the instance is sampled, not blocked:** 593 × 200 vs 87 × 403 (`cf-chl-tk`) in one hour, so the DB lanes keep working at ~87 %. **What passes:** a real browser PAGE. In-page `fetch` from a dapper.market tab got 200 in 709 ms (Chrome), and headless Chromium does too **only** when launched as the full browser (`channel: "chromium"`, not the headless shell), **without** `--enable-automation`, with `--disable-blink-features=AutomationControlled` and a desktop Chrome UA/locale/timezone/viewport — with defaults the LANDING page itself is challenged (`HeadlessChrome` UA). Recipe + parser: `scripts/ingest-topshot-active-listings.mjs` (`ATLAS_FETCH_MODE=browser`), register #125. ⛔ **Do not replay browser cookies from Node — the clearance rides the page, not the jar.** ⚠ **The challenge page is a 403 with an HTML body: a client that keys on "non-JSON" sees it as a WAF block; classify it by `Just a moment` / `cf-chl` and name the mechanism** (`parseAtlasBoundary`).

| method | body | answers |
|---|---|---|
| `MarketplaceService/SearchMarketplaceTransactions` | `{product:'nba'\|'nfl', limit≤200, offset}` | the platform-wide FIREHOSE, newest `listedAt` first: listings (`completed=false`), sales (`completed`+`purchased`, `purchasedAt`, buyer+seller, `marketplaceFeeCents`, `sellerProceedsCents`), offers (`offerType` EDITION\|PARALLEL\|SERIAL, `buyerAddress`), filled offers. ~4–7 events/min on nba (a dated sample). |
| same | `+ {editionId}` | that edition's OPEN listings, price ascending, with serial + nftId + seller (= the site's Listings tab) |
| same | `+ {editionId, completed:true}` | that edition's sales history |
| same | `+ {nftId}` | one Moment's listing + sale history — the verification-by-listing check |
| same | `+ {sellerAddress}` | a wallet's listings (0x optional) |
| `ProfileService/SearchUserProfiles` | `{product:'nba', username}` | `userProfiles[0].flowAddress` (+ `username`, `profileImageUrl`, `favoriteTeamIds`, `createdAt`); `flow_addresses` is the reverse lookup: `{product:'nba', flow_addresses:[…]}` answers up to **25** addresses in ONE request (26+ → `400 invalid_argument: too many identifiers: max 25`, measured 2026-09-29); a wallet with no Dapper profile is simply absent, so key hits on the echoed `flowAddress`. Used by pg_cron `rpc-member-wallet-usernames-atlas` → `wallet_usernames` |
| `EditionService/SearchEditions` | `{product, setId:[…], limit, offset}` | the edition catalogue (the badge lane, `atlas_editions_*`) |

⚠ **Unknown keys are IGNORED, no error** — a misspelled filter silently returns the firehose; assert on the
answer's shape, never on the request having been accepted. Pagination: `pagination.hasMore`.

**What is built on it (migration `20260906203504`):** `topshot_atlas_market_events` (one row per Atlas
uuid, both products, anon-readable) fed by `atlas_market_dispatch()` / `atlas_market_drain()` on pg_cron
every 2 min (pipeline `atlas-market-feed`), and the two-phase RPCs `atlas_resolve_username_{begin,collect}`
/ `atlas_verify_listing_{begin,collect}` (service_role). ⚠ **Delistings are NOT in the firehose** — a
listing that vanishes without a sale is only seen by re-reading `{editionId}`; open-listing truth for the
sniper needs a per-edition refresher, not the firehose alone.

⭐ **Username → wallet has ONE app entry point (2026-09-29):** `resolveToFlowAddress` in
`lib/chains/flow/flow-resolve.ts` → `resolveTopShotUsernameCacheAware` (cached layers → the Atlas
`ProfileService` read above → the dead Top Shot GQL only as a last resort). It throws
`UsernameLookupUnavailableError` when it could not LOOK (answer with `usernameLookupUnavailableResponse()`,
a 503) and the "Could not resolve …" error on a confirmed miss. Ten routes used to carry private copies
that went cache → a dead GraphQL host (Set Trackers, collection tab, analytics cards); all now use this
one. A Dapper username names one Flow address across collections, so All Day routes use it too.
⚠ **Measured the same evening: a 6-request probe burst plus a few route calls took `ProfileService` to
6/6 `Just a moment…` for ~5 minutes, then a single request answered cleanly** — #65's burst rule applies
to this endpoint too, and the routes honestly answer 503 while it lasts. Never probe it in parallel.

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
- ⚠ (2026-10-03) The "rejects" below is the PURCHASE-history service. **EditionService/SearchEditions answers Golazos under product `laliga`** and Pinnacle under `disney` (full supply buckets); UFC is rejected under every name tried.
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
  `onchain` 102), already **100 %** filled. ✅ **RESOLVED 2026-09-08 by a controlled probe — the `*_studio_history_v1` hash question is settled and
  the answer DIFFERS BY COLLECTION.** Randomised sample (`hashtext`), all **above** the spork wall so a
  pruned empty-200 could not be misread as "not a purchase":

  | arm | purchase tx (`ListingCompleted` + NFT `Withdraw`) | events |
  |---|---|---|
  | `allday_studio_history_v1`, seller FILLED (positive control) | **3/3** | 62 · 62 · 81 |
  | `allday_studio_history_v1`, seller NULL | **2/3** | 62 · 62 · 6 |
  | `ufc_studio_history_v1`, seller NULL | **0/3** | 6 · 6 · 6 |
  | `golazos_studio_history_v1`, seller NULL | **0/3** | 4 · 4 · 4 |

  ⭐ **The discriminator, reusable:** a **purchase** carries `NFTStorefrontV2.ListingCompleted` **and** an
  NFT `.Withdraw`, and runs **62–81 events**; a **listing creation** carries only `ListingAvailable` plus
  fee movements at **4–6 events**. ⚠ **Both answer `Success`/`Sealed` on a 200 — the event set is the only
  discriminator, never the status.**

  ⇒ **UFC + Golazos studio-history rows point at LISTING transactions and are structurally undecodable**
  (0/6); their exclusion is correct and permanent. ⇒ **All Day's are MIXED and mostly REAL purchases** —
  its exclusion from `claim_sales_counterparty_batch` is also correct, but for the opposite reason: a
  DEDICATED lane owns them (`allday-buyer-backfill`, 16/16 ok and 1,920 rows per 48 h on 2026-09-08), so
  the exclusion prevents DOUBLE WORK, not recovery. ⚠ At ~960/day the remaining ~277,886 above-wall rows
  need **~289 days** — slow but progressing; that is a throughput fact, not a defect. The rows are not
  duplicated (78,073 : 78,073 distinct hashes, 1.45 per nft), so they are genuine sales.
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
- Vercel routes that hit consumer/graphql directly (`lib/alldayGraphql.ts`, allday-wallet-search, allday-sets) work because Vercel egress isn't WAF-blocked there. Edge functions and other non-Vercel egress need the worker. ⚠ **Unverified and contradicted, 2026-09-29:** the line above conflicts with this section's opening ("blocks Vercel + Supabase egress") and with the sniper route's own record of All Day GQL 403s from Vercel egress; re-measure before relying on it. `allday-sets` no longer resolves usernames here (it uses `lib/chains/flow/flow-resolve.ts`); `allday-wallet-search` still does and has no in-app caller (known-issues #163).

### Flowty API

POST `https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot`.
Required headers: `Origin: https://www.flowty.io`. `blockTimestamp` is in milliseconds. `valuations.blended.usdValue = LiveToken FMV equivalent`. 4 pages = 96 listings max. `buyUrl = https://www.flowty.io/listing/{listingResourceID}`.

All listing-cache routes use `flowty-proxy` Supabase edge function (Flowty blocks Vercel IPs). `cached_listings` upsert-then-conditional-purge, threshold = function-top `startedAt`. TS `onConflict: "flow_id"`. Flowty wins dedup on `flowId`.

### Flowty Pinnacle FMV floor issue (open)

Flowty Pinnacle emits uniform $1 floor across 10k+ listings (`upstream_floor_only=true`) — NOT a parser bug, real marketplace behavior. `cached_listings` ASK unreliable for Pinnacle until direct integration.

### Flow REST API scripts

Each argument must be `btoa(JSON.stringify({type, value}))` — NOT raw object. Response: `atob(raw.trim().replace(/^"|"$/g, ""))` → `JSON.parse`. `access(all)` required (not `pub`). Use `Buffer.from(str, 'utf8').toString('base64')` for Cadence encoding (NOT `btoa()` — breaks on Unicode).

### ⭐ Past heights: Flow's historical spork nodes still answer — back to 2023-11-08 (2026-09-29/30, PT)

**"Before the 2025-12-29 spork is unreachable" is WRONG.** `http://access-001.mainnet24|25|26|27.nodes.onflow.org:8070` serve the same REST API (scripts at `?block_height=N`, `/v1/events` ≤250 blocks, `/v1/transaction_results/{tx}?block_height=h`) — reachable from **pg_net**, not from the sandbox. Ends: 24 ≤ 85,981,134 · 25 ≤ 88,226,266 · 26 ≤ 130,290,658 · 27 ≤ 137,390,145; mainnet28 = `rest-mainnet.onflow.org`. **The floor is mainnet24's root, 65,264,619 (2023-11-08)** — mainnet23 and older fail DNS. Gotchas, each measured:
- ⚠ **Syntax is per NODE, not per height** — mainnet24 runs pre-Cadence-1.0 (`pub fun`, `getCapability(p).borrow<…>()`); mainnet25 rejects `pub`, so 25–28 take Cadence 1.0.
- ⛔ **mainnet25 runs NO script on 85,981,135..86,031,699** (`400 "node version is incompatible with data for block"`, bisected to the block 2026-09-30); every height from 86,031,700 works, and its **events** read that gap fine. Split any script bisection at 86,031,700; walk the gap by events.
- ⚠ **Rate limits:** a burst of 105 on mainnet26 drew 85 × 429, 20 were clean — cap per node per tick. ⭐ **The limit is per-SECOND bursts, not a per-minute budget** (09-30: three bursts of 20, two seconds apart, 60/60 clean), so one burst a minute leaves the node idle ~59 s. Spread calls across the minute, in slots clear of the other lanes' (`20260930221000`: chain arrivals at :00/:08/:23/:38/:53). **A 429 and a 503 (`upstream connect error … connection failure`, a 4-minute outage 09-30 05:04 AM PT that spent 159 probes' whole retry budget) are free retries, not failed reads.**
- ⚠ A 1,000-id holdings script on a wallet that holds most of them returns **500** (compute limit); 300 pass — retry in halves. An events window can be ~12 MB (21,794 events): MATERIALIZE the parse CTEs.
- ⭐ **Wallet-history technique (2026-10-03, Trevor's Flowty export):** a wallet's key `sequence_number` (`/v1/accounts/{a}?block_height=h&expand=keys`, sum over keys) counts every tx it PROPOSED — bisect it to ≤250-block windows, then read events per window; prove coverage by summing seq deltas (3,428/3,428 · 491/491 · 16,673/16,673). Flowty's Funding / storefront Listing resources keep `repaid`/`settled`/`purchased` flags until a post-shutdown cleanup, so per-item outcome = bisect the flag (record missing = ended). Scratch code: `flowty_archive.scratch_walk_tick()`, `scratch_loan_tick()`, `scratch_listing_tick()`. ⚠ At 40 calls/node/tick it tripped the HIGH `pg_net_http_429` alert — keep ≤20.
- ⛔ **Below the floor (before 2023-11-08), re-measured 2026-10-03 PT:** mainnet20/23 still fail DNS **from pg_net too**; `api.findlabs.io/historical/api/rest` (Find Labs' old keyless historical API) resolves but never completes TCP; Flipside's docs domain now serves an unrelated company (edisyl); Bitquery has dropped Flow (frozen data, unverified). **Only live full-history EVENT sources: Dune `flow.cadence_events` and Find Labs `api.find.xyz` (401 without a key; claims data from mainnet1, Oct 2020; has `/flow/v1/account/{a}/transaction`).** Flowscan renders server-side — no public API to call.
- ⭐ **STATE below the floor is free and public (found 2026-10-03):** `gs://flow-genesis-bootstrap/mainnet-NN-execution/public-root-information/root.checkpoint*` = the full ledger at every spork root (mainnet-20…24 = 16-part V6, 193–339 GB; mainnet-15…19 single file, older format, unparsed). No events — but any contract that KEEPS its records (Flowty Funding/listings, collections, storefronts) is readable at each root. Leaf payload = `[u32 keyLen][u16 2][u32 10][u16 0][owner8][u32 len][u16 2][registerKey][u32 valLen][atree slab]`; stream parts by HTTP Range, grep the 14-byte owner prefix, keep matches (whole mainnet-24 scan ≈ 20 min from the sandbox, 16 streams). `access(contract)` fields (e.g. Flowty lender/borrower capabilities) ARE in the raw slabs (`\xd8\x83H` + 8-byte address). Scripts at a node's ROOT height read the same state through Cadence. Validated 3/3 against post-floor events. Case: ledger 2026-10-03 "Pre-2023-11-08 Flow history WITHOUT Dune". ⚠ **mainnet-17/18 keys have THREE parts** (`[u16 3][owner][u32 2][u16 1 controller][key]`) — prefix `0003 0000000a 0000`; 19+ have two. **Format by era (corrected 2026-10-03 PT):** mainnet-15 (2021-12) onward is atree (slab decoders work); **mainnet-6..14 (2021-03..10) are pre-atree** — one register per stored value, and a collection's `ownedNFTs` KEY ARRAY in its own register is the authoritative id list (`scripts/flow-checkpoint/decode_old_wallet.py`; standalone per-NFT registers can be empty tombstones — 36 in mainnet-7). mainnet-1..5 extract fine (positive control: Top Shot's own account) but hold nothing for an account created later. Flowty's NFTStorefrontV2 (0x3cdbb3d569211ff3) first appears in the 2023-02-22 snapshot (0 listings at 2022-11/2023-01); purchased listings persist in sellers' storefronts (8,205 at 2023-11-08) — pre-2024 Flowty sale prices, buyer NOT recorded. Flowty's loan book is complete from launch (2022-01-23) in every later snapshot; decoded Top Shot holdings = `getIDs()` 4,778/4,778.
- 🚨 **The wallet walk above is PROPOSER-complete, not ACTIVITY-complete (corrected 2026-10-03 PT):** "16,673/16,673" proves every tx the wallet PROPOSED was read — but a sale of your listing, an offer of yours being filled, and any tx Dapper proposes for a custodial wallet run in the COUNTERPARTY's or Dapper's tx, so they never enter the walk. Measured on Trevor's export: the walk had 6,779 trades; Flowty's own index held **7,942** (146 Dapper-wallet storefront sales + 756 offer trades + 31 Dapper-storefront buys it never saw; all 821 re-checked sealed on chain, ids matching). Pair a walk with an index keyed on the counterparty side.
- ⭐ **Flowty's own event index is still publicly readable (found 2026-10-03 PT) — and it reaches below the floor, back to launch (2022-07 rentals, 2022-08 loans, 2023-01 storefront).** Flowty's web client read Firestore project `flowty-prod` directly (config in its archived `main.*.js`, Wayback); the security rules leave `p2pEvents` (LISTED/FUNDED/REPAID/SETTLED/DELISTED/EXPIRED), `rentalEvents` (RENTAL_LISTED/RENTED/RETURNED/DESTROYED), `storefrontEvents` (LISTED/PURCHASED/DELISTED/OFFER_CREATED/ACCEPTED/CANCELLED, incl. Dapper OffersV2 offers made through Flowty: `resolverType …FlowtyOffersResolver`), `events` (a superset mirror), and the state collections `fundingAvailable`/`listingAvailable`/`rentalAvailable`/`listingRented` open to `documents:runQuery` (other names 403). Every event carries `transactionId` + `blockTimestamp`, and the **buyer** that pre-2024 storefront state lacks. Filter fields: `accountAddress`, `data.buyer`, `data.storefrontAddress`, `data.flowtyStorefrontAddress`, `data.lender`, `data.borrower`, `data.renterAddress`, `data.taker`/`payer`; an `IN` filter on one field needs no composite index. Controls: 17/17 pre-floor loans match the checkpoint to the second; 73/74 snapshot-inferred purchases confirmed at the exact price (the 74th was a false match); 2 repayments AT the 2025-12-29 spork are missing from it (chain wins). `api2.flowty.io/nft/{addr}/{name}/{id}` (Origin `https://www.flowty.io`) still returns card title/set/serial — the name fallback. ⭐ **Any wallet: `scripts/flowty-export/flowty_export.py`** (stdlib; the sandbox reaches Firestore directly; refuses a partial walk). Case: ledger 2026-10-03 "Flowty index".
- ⭐ **Flowty-venue history for ALL users (2026-10-03 PT) — archive, verify, name, then promote.** (1) `flowty_archive.flowty_index_sales` = every STOREFRONT_PURCHASED / OFFER_ACCEPTED doc in Flowty's index, **2,880,364, reconciled per doc-id partition against the server's own `runAggregationQuery` counts** (pg_net harvest, projection mask, `__name__` range + cursor; an `IN` on `type` plus a `__name__` range needs no composite index; `nftType`+`blockchainType`+`blockTimestamp` together DOES — 400). (2) **The chain, not the index, is what reaches `sales`:** `flowty_archive.flowty_chain_listing_completed` is a full 250-block walk of `A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted` (Flowty's fork emits `buyer` + `storefrontAddress` in the EVENT, so one read is a whole sale), with coverage in `flowty_chain_walk_coverage` written in the same statement as the events. ⛔ **Never run that walk from pg_net:** a `/v1/events` window on a history node takes ~30 s and the shared pg_net worker waits for its whole batch — 80 in flight → queue 104, 41 s with no response for ANY lane (stopped 10-03). It runs on GHA (`flowty-chain-walk.yml`), latency-bound at ~0.7 windows/s per job. (3) **Naming a sold NFT needs a holder-independent map:** RPC's own maps knew ~32 % of the Top Shot / ~5 % of the All Day NFTs Flowty sold; `public.checkpoint_nft_meta` (decoded from the mainnet-28 checkpoint by `ckpt_nftmeta.py`, loaded by `checkpoint-nft-meta-load.yml`, scoped to `checkpoint_nft_meta_wanted`) names any NFT that existed at 2025-12-29. ⚠ **Post-Cadence-1.0 atree is NOT the named-field format the older decoders read:** NFTs are inlined composites (tag 252) whose values follow the slab's OWN type-info field list, and all 6 orders of setID/serialNumber/playID occur in one 128 MB slice — map by name, never by position. Top Shot parallels live in the contract account's `momentsSubedition {UInt64: UInt32}` (absent = Standard). (4) Controls: index vs RPC's chain ingest on 70,039 overlapping 2026 sales — buyer 99.70 %, seller 99.83 % identical (the rest: paying Flow parent vs receiving Dapper child); chain vs index 28/28 exact. Index ≠ chain BUYER semantics only in that 0.3 %. Promotion: `flowty_archive.promote_flowty_chain_sales(from, to)` → `sales.source = 'flowty_chain_v1'`, USD-pegged vaults only (FLOW/FUT have no historical rate here → archive only), never a guessed edition. Ledger 2026-10-03 "Flowty-venue history". **Outcome (2026-10-04 ~8:15 AM PT, final):** walk coverage complete on mainnet25–28 (mainnet24 verified per transaction instead); `flowty_chain_v1` **1,354,989** rows (TS 1,028,222 · AD 315,593 · UFC 8,753 · GZ 2,421; 2024-09-04 → 2026-05-14) + `flowty_chain_tx_v1` **234,811** (mainnet24 era; TS 170,873 · AD 61,344 · UFC 2,014 · GZ 580). Index verdicts on every Flowty-contract storefront doc: after mainnet24 **1,722,559 / 1,722,559 `chain_sealed`** (no index sale the chain lacks); mainnet24 era 297,312 sealed, **30 `chain_mismatch` — all transactions the node reports as never sealed (`Expired`), kept out** — and 9,272 `unverifiable_pre_floor`. RPC's own ingest had missed ~95 % of the Top Shot Flowty sales of May 2026 (1,437 / 1,500 sampled had no `sales` row of any kind). Integrity at close: 0 duplicate tx + nft, 0 self-trades, 0 null editions, 0 non-positive prices.
- ⭐ **Third-party venues in Flowty's index — verify each sale against ITS OWN transaction, take the parties from the CHAIN (2026-10-04 PT).** Flowty's `storefrontEvents` index also carries sales on contracts that are not Flowty's: Dapper's `NFTStorefrontV2` `0x4eb8a10cb9f87357` (customID `DAPPER_MARKETPLACE` = the collection's own marketplace; `flowverse-nft-marketplace` = Flowverse) and Dapper's `OffersV2` `0xb8ea91944fd51c43`. All Day / UFC / Golazos **offer accepts were absent from `sales` entirely**. Lanes: (a) mainnet24 era (2023-11-08 → 2024-09-04): that node takes ~60 s per `/v1/events` window but < 0.5 s per `/v1/transaction_results/{tx}`, so Flowty-contract rows are verified per transaction (`flowty-tx-verify.yml`, source `flowty_chain_tx_v1`); (b) Dapper-contract rows on every era (`dapper-tx-verify.yml` → `ingest_dapper_tx_verdicts`, method `tx_dapper` → `promote_dapper_tx_verified_sales`, source `dapper_chain_tx_v1`). ⛔ **Flowty's index has the WRONG parties on Dapper-contract rows** — OffersV2: the offer maker as BOTH buyer and seller; storefront: buyer NULL, seller `''`. On chain: offers seller = `acceptingAddress`, buyer = `offerAddress`; storefront seller / buyer = the NFT's own `Withdraw(from)` / `Deposit(to)` in that tx. Controls: chain parties = Flowty's independent fields (`buyer`, `extra.taker`) on 14,469 / 14,469 offers and 4,830 / 4,830 storefront rows that have them. ⛔ **`atlas` Top Shot rows carry NO `transaction_hash`** ([database.md](database.md), #68 lineage), so a tx + nft dedup is blind to them: 400 / 400 sampled Top Shot marketplace rows were already in `sales` as atlas rows ~2 s away. Every promoter of a sale RPC may already hold must also skip a same-NFT sale within ±10 min from ANY source. ⚠ Pre-Cadence-1.0 events type a vault as `Capability<&Vault{Provider,Balance}>`: the `Restriction` node carries its own `typeID` `…Vault{…}` — the vault is the INNER type. ⚠ A `transaction_results` read must try every spork node before calling a tx NotFound (era boundaries are approximate). ⚠ `http.client.IncompleteRead` is an `HTTPException`, not an `OSError` — a retry loop catching only `URLError`/`OSError` dies on a truncated body. ⚠ A verifier page that re-filters "already in `sales`" on every read times out (30 s service_role cap) — build the candidate set once (`flowty_archive.dapper_tx_candidates`). **Outcome (2026-10-04 ~8:15 AM PT, final):** 44,843 Dapper-contract rows read, **44,843 sealed, 0 mismatches** after the restricted-type fix; 7,447 further candidates skipped as hashless-atlas duplicates without a read; `dapper_chain_tx_v1` **22,135** rows (AD 9,446 · TS 5,959 · GZ 3,731 · UFC 2,999; Nov 2023 → Sep 2026), venues `topshot` / `nflallday` / `laligagolazos` / `ufcstrike` (Dapper's own marketplace and offers) and `flowverse` (customID `flowverse-nft-marketplace`, 2,568). UFC rows whose set maps to more than one edition stay unpromoted (never guessed). Ledger 2026-10-04 "Dapper". **Sale-block holder reads (2026-10-04 PM PT) — naming an NFT no checkpoint holds:** a sold NFT that is in no spork-root checkpoint (minted and moved inside a spork) is named by reading the BUYER's collection at the sale's own block (`/v1/scripts?block_id=` on that era's history node; `sale_block_read_gha.py`, `sale-block-read.yml`, `flowty_archive.sale_block_read_candidates`, meta rows → `checkpoint_nft_meta` spork 1). 143,942 candidates: 143,842 found, 86 absent, 15 unread; every record validated against the catalog (edition exists, serial ≤ circulation / set max). Re-promotion added **+143,575** sales (walk +88,218 · tx +52,348 · Dapper +3,009), 0 null editions. ⚠ Only `access-001` exists per history spork; **mainnet26 rate-limits script bursts (429)** — pace per node, a 429 is a retry, never a verdict. ⚠ **mainnet24 answers some (block, script) pairs with a deterministic HTTP 500** (an All Day wallet whose capability is neither typed nor CollectionPublic) — three strikes, then NO verdict (never "absent"); a 500 retried as a flake stalled every shard ~5 min a group. ⚠ Pre-1.0 All Day wallets may publish a generic `&AnyResource{CollectionPublic, Receiver, ResolverCollection}` capability: the typed borrow finds nothing, so fall back to MetadataViews (`Medias[0]` = `…/editions/<editionID>/media/…`, `Serial`). ⛔ **Two promoters that each "check already-in-sales, then insert" must never run over the same blocks concurrently** — the walk and tx lanes did, and wrote 7 sales twice (no unique key on `(transaction_hash, nft_id)`); parallel ticks need a per-slice advisory lock plus a re-check after taking it. ⛔ **A promoter's `unresolved_edition` is NOT the gap — it counts every candidate without an edition, INCLUDING ones already in `sales`** (sold through RPC's own ingest). "~19.8k still unnamed" measured down to the real gap (chain-verified, USD-pegged, not in `sales` on tx + nft): walk 787, tx 396, Dapper 1,071 — and most of those are already represented: ±10 min same-NFT rows (hashless atlas), the All Day `trg_zzz_allday_cross_source_dedup` trigger (silently folds a same-NFT / same-day / same-price sale from another source into the existing row — a promoter's `eligible` > `inserted` gap of exactly 160 was this), UFC sets with no catalog edition. Measure the gap from the source table, never from a self-report. ⚠ **`edition_conflict` can mean the LOCAL map is wrong:** 808 Top Shot sales were held back because `topshot_moment_subeditions` named a different base than the checkpoint, and the checkpoint was right (serial fits 100 % vs ~82 %; same player, different set) — #173.
- ⭐ **Checkpoints answer WHO HELD AN NFT — any account, not just yours (2026-10-03 PT, `scripts/flow-checkpoint/ckpt_find.py`).** Match the atree field pair `"id": UInt64(n)` (`\x62id\xd8\xa4` + CBOR uint — ids use the SHORTEST CBOR form), walk back to the enclosing payload for its owner, keep payloads naming the contract address. Positive control: 113/113 of one wallet's known holdings found under it. Read-outs that recur: an id found in NO account was destroyed (burned); `0xe1f2a091f7bb5245` (`TopshotAdminReceiver`, 1,804 keys) is Top Shot's issuer — a moment there is still in an unopened pack; `0xe4cf4bdc1751c65d` likewise for All Day. Used to test 216 pre-floor Flowty purchases against the seller/issuer/mint state before and holder after: 0 contradictions. ⚠ **Atree field order inside a composite VARIES (`data` can precede `id`) — a one-sided search window silently decoded only 2,325 of 4,778 moments.** Names from the chain: Top Shot `setID:playID` → `editions.external_id`; All Day `editionID` → `editions.external_id`. ⛔ **Flowty card titles (`api2.flowty.io/nft`) are not a name source for Top Shot:** 164 of 5,788 disagreed with the chain, every one Flowty's error (`TopShot #<id>` placeholders, play-type suffixes, the id in the serial field).
- Lanes built on it: `run_topshot_pull_chain_lane`, `run_chain_arrival_lane`, `run_pinnacle_opener_lane`, `run_pack_mint_probe_lane`. Full case + results: [packs.md](packs.md) ("Reading the chain at a past height", "Custodial rips on chain").

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
- NFTStorefrontV2 (Dapper): `A.4eb8a10cb9f87357.NFTStorefrontV2` — ⚠ **CORRECTED 2026-09-25: NOT "packs only".** It carries most live NFL All Day and LaLiga Golazos moment listings (measured: All Day's 25 biggest sellers ~5,850 live V2 listings; Golazos 3,338) as well as Top Shot PackNFT / Pinnacle / MFL. Buyable.
- NFTStorefrontV2 (Flowty fork): `A.3cdbb3d569211ff3.NFTStorefrontV2` — ⛔ **UNPURCHASABLE, not merely dormant.** Its deployed `Listing.purchase()` begins `assert(false, message: "Purchases have been disabled. See Flowty discord for more details.")` and `createListing()` asserts false (read 2026-09-25). Its listings still exist on-chain and look open to an event indexer; never treat one as an ask. See **Storefront listings: source map, reconciliation, pricing** below.
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

## Displaced from CLAUDE.md 2026-09-19 (verbatim) — the Cadence pre-flight

> Moved here to buy room for the discovery-vs-refresh rule, per the pairing discipline in
> `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts`: an addition arrives WITH its
> displacement and the displaced text moves VERBATIM. That guard's header warns explicitly against
> ranking sections by SIZE — the big ones are big because they carry incidents. This was chosen on
> 'does the need ANNOUNCE ITSELF': you are already in a `.cdc` file when you need it, unlike the
> rules a reader must have before knowing to look. CLAUDE.md keeps a one-line pointer.
>
> ONE byte is not verbatim: the block's closing pointer read `[apis-and-cadence.md](docs/reference/apis-and-cadence.md)` — a self-link from inside this file, which resolves to `docs/reference/docs/reference/…` and reddens the Memory-doc link guard. It now names the section above instead.

### Cadence

**Before modifying any `.cdc` file, Cadence string literal, or FCL `mutate`/`query`, fetch the deployed mainnet source via the Cadence MCP and verify the functions/fields/types exist** — training data is frequently wrong for Cadence 1.0. MCP is dev-time verification ONLY; production reads route through the proxy (egress blocked). Addresses (incl. the service payer wallet) + gotchas: **the Per-collection Cadence gotchas section above in this file**.

## Dapper studio `searchPackMarketplaceHistory`: pass a UNIQUE sort tiebreak or bulk transactions lose rows (2026-09-24, PT)

With no `sortBy`, the API orders by `created_at.block_time` alone. Its opaque cursor then resumes at "`ListingResourceID` < last seen" inside a tied `block_time`. Rows inside a tie do NOT come back in listing-id order, so **a page boundary inside a bulk transaction skips rows**.
- Measured on Golazos (about 11 packs per tx): the same 200 rows, fetched in one call and then paged 100 + 100, came back with 72 of one 115-row tx missing. `totalCount` fell by 172 for 100 rows read.
- Top Shot and All Day have one sale per tx, so they barely notice.

**Fix (`9939bbac6`, `PACK_SALES_SORT`):** `sortBy: { created_at: { block_time: { direction: DESC, priority: 1 } }, listing_resource_id: { direction: DESC, priority: 2 } }`. The cursor then carries both fields, and the paged set equals the one-shot set.
- An old-format cursor is still accepted.
- Top Shot and All Day return the identical head set either way.

⭐ **The cheap detector is `totalCount` itself:** it counts rows AFTER the cursor. A walk whose `totalCount` falls by more than the rows it read is skipping. Golazos pack sales went from 15,333 stored to exactly the API's 31,846 after one clean re-walk.
⚠ The pack-OPENS index (`searchPackNft`) is not affected. Its cursor is a full `[block_height, id, type]` tiebreak, and stored equals the API total on both lanes.

## Reading Top Shot NFT truth from the chain without the dead GraphQL host (2026-09-24, PT)

`net.http_post` → `https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed` with a base64 Cadence body, then decode the base64 JSON-Cadence response from `net._http_response`. Read the deployed source first (`/v1/accounts/0x0b2a3299cc857e29?expand=contracts`).
- Contract-level views, no holder needed:
  - `TopShot.getNumMomentsInEdition(setID, playID)`: minted count. Use it to test a `circulation_count`.
  - `TopShot.getMomentsSubedition(nftID)`: nil for pre-subedition moments, 0 for base, N for a parallel.
- Per moment you need the holder: `getAccount(addr).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)?.borrowMoment(id: id)?.data` gives `{setID, playID, serialNumber}`.
- Batch about 125 (id, holder) pairs per script. Candidate holders come from the latest `sales.buyer_address`, `topshot_ownership` and `moments.owner_address`.
- A moment that has moved returns nothing: record "not held", never "wrong".
- Used for #116: `docs/audits/i116-chain-adjudication-2026-09-24.md`.
- ⭐ **2026-09-25 (#142) additions.** (1) `getNumMomentsInEdition` batches cleanly — one script over 42 `[[setID, playID]]` pairs returned all 42 counts; build the argument with `string_agg(… ORDER BY …)` so results map back by position. (2) **It counts base + ALL parallels** — compare it with `sum(circulation_count)` over `base` and `base::*`, never the base row alone (the 09-22 lesson; 5 "mismatches" were exactly that). (3) **Run a positive control before trusting a zero:** an owner walk found 0 of 74 misattributed moments still with their last buyer; the same script over the 20 most recent sales found 20 of 20 with set/play/serial/subedition all matching — so the zero was real (the moments had moved), not a broken script. (4) Holder coverage is the limit: of 1,288 misattributed NFT ids only 74 had a buyer address, 2 a `topshot_ownership` row and 1 a `moments` owner.

## Catalog names the Dapper API no longer serves ARE on chain (2026-09-25, PT)

The QA pass wrote down "nothing to do on our side" for two catalog gaps. Both answers were on chain all along (#137 (d), (h)):

- **Pack distribution names:** every Dapper distribution is registered with the PDS contract (`0xb6f2481eba4df97b`, the same one the All Day / Golazos seeder walks). `PDS.getDistInfo(distId)` returns title, tier and slot count. Route: `/api/cron/topshot-pack-dist-names-onchain`.
- **Top Shot set series:** `TopShot.getSetSeries(setID)` (read through Flow REST). `catalog_topshot_from_atlas` inserts `sets.series` as NULL by construction, so this route fills it: `/api/cron/topshot-set-series-onchain`.
- ⚠ **Before filing "no source for this field", check the mainnet contract for a getter.** An off-chain API going dark takes away a copy of the data, not the data itself.
- ⚠ Still not read from chain: the 48 named dists' `total_minted` / `total_sealed`, which remain a DEFAULTED 0 (#137 (d)).
- 🚨 **A fill from the chain must survive the original source's next refresh.** Three hours after the 48 names were filled, `seed_topshot_pack_distributions` upserted `title = EXCLUDED.title` from the Studio API, whose title is NULL for exactly these rows, and 45 of the 48 went back to "Pack #8825". Fixed in `20260925132658`: the seeder keeps a known title and merges metadata through `jsonb_strip_nulls()`. **Before calling a fill durable, grep every writer of the column for `= EXCLUDED.`, in the live DB and in app-side `.upsert(…, { ignoreDuplicates: false })`.** The sweep for today's other fills is in [database.md](database.md).

## Storefront listings: source map, reconciliation, pricing (2026-09-25, PT)

**`cached_listings_v2.source` is per-INDEXER, not per-contract — read the collection's indexer `sourceFor` before filtering on it.**

| collection | `direct` | `direct_v1` | `direct_v2` | `storefront_v2` |
|---|---|---|---|---|
| NFL All Day | Flowty fork — ⛔ unpurchasable (27,406 rows closed `unpurchasable`, `20260925230134`) | Dapper V1 — buyable (sample: 3,016/3,017 open rows still on-chain) | Dapper V2 — buyable | reconciler rows (Dapper V2 state, no event metadata) |
| LaLiga Golazos | Flowty fork (no open rows) | Dapper V1 | Dapper V2 | reconciler rows |
| Disney Pinnacle | **Dapper V2** — buyable | — | — | — |

**The storefront reconciler** — `/api/cron/golazos-storefront-reconcile?collection=laliga_golazos|nfl_all_day` (Vercel cron; Golazos `43 */2`, All Day `13 1-23/2`; pipelines `golazos-storefront-reconcile` / `allday-storefront-reconcile`; code + rules in `lib/golazos/storefront-reconcile.ts`). It walks each known seller's Dapper V2 storefront and reconciles `direct_v2`/`storefront_v2` rows: inserts listings the event indexer never saw (it only sees events after it started; Golazos went 514 → 3,338 open), resolves editions through the listing's own provider capability (works for sellers with no public collection — 244 Golazos rows had none), closes `ghosted` / `vanished` / `expired`, stamps `verified_at`. Sellers come from `storefront_reconcile_sellers(collection, sale_days)` (ONE array — a SETOF clamps at 1,000). Only a seller whose walk SUCCEEDED is reconciled; V1 and Flowty-fork rows are never touched.

- ⛔ **bigint ids arrive from PostgREST as JSON NUMBERS; the chain returns strings.** The first run matched nothing, inserted 3,338 duplicates and closed 514 rows as vanished (repaired, `20260925215205`). Select ids `::text` and key maps on `String(id)`.
- ⚠ **`rest-mainnet.onflow.org` is QuickNode-fronted at 100 requests/SECOND, shared by every Flow lane.** 12 concurrent walks got 412 × 429. The reconciler walks 3 at a time with exponential backoff on 429.
- **Disney Pinnacle is deliberately NOT reconciled (measured 2026-09-25).** Its `cached_listings_v2` book (source `direct` = Dapper V2) is badly ghosted — e.g. seller `0xab20…` 1,058 on-chain listings / 0 live, `0xaec8…` 1,194 / 10 — and the largest seller (6,695 rows) exceeds the script computation limit. But NO reader prices or displays from it: Market and pricing read `pinnacle_catalog.floor_ask` (studio-platform GQL); the only DB readers are `resolve_moment_id` and `bc_continuity_status`. Re-check the readers before building one — and page any walk of a >5k-listing storefront.
- `hasListingBecomeGhosted()` returns TRUE when the NFT is still held — the name reads backwards. `borrowNFT()` force-unwraps the provider, so call it only after that check.

**Ask pricing from the book** (ASK_ONLY, FMV = 90% of the cheapest live ask, ask = floor, never a sales-backed row):
- Golazos — `refresh_golazos_ask_fmv_from_listings()`, pg_cron 614 `55 */2`, counts a listing only if `COALESCE(verified_at, listed_at)` is within 6 h (a stalled reconciler stops pricing; proven live: priced 0 with 3,336 unverified before the first stamp). `fmv_from_cached_listings` (Flowty cache) prices no Golazos or All Day.
- All Day — `refresh_allday_ask_fmv_from_listings()`, job 19, ghost-filtered by `allday_listings_sold_after_listing`. Both lanes re-derive their OWN rows when the floor moves either way (`20260925231149`).

## FCL in the browser: two signers, one session per tab (2026-10-04, PT)

Learned building `/admin/swap-test` (handoff: `docs/strategy/trading-revisit-2026-10-03.md` §9).
- ⚠ **FCL (`@onflow/fcl` 1.21.9) keeps the connected wallet in `localStorage` by default** (`storage: params.storage || LOCAL_STORAGE`), which **every tab of a browser profile shares**. A second tab that connects another wallet overwrites the stored session. Set `fcl.config().put("fcl.storage", fcl.SESSION_STORAGE)` **before the current-user actor first spawns** (it reads the provider once).
- **A second signer from another session works through FCL's own pipeline.** Pass a custom authorization function whose `signingFunction` fetches the signature elsewhere (the relay). The payload names authorizers **by address only**, so the signer's key index is only needed for its signature entry: set it on `signable.interaction.accounts[...]` (`signable.interaction` IS FCL's interaction object) before returning. Proven with real keys in `__tests__/swap-test-fcl-two-signer.test.ts`.
- **FCL merges duplicate authorizers by address**, so one account can't fill two `prepare(a, b)` slots.
- ⚠ **One Flow Wallet EXTENSION holding both accounts may sign with whichever account is ACTIVE**, and the payer's envelope approval can come after the co-signer's. Run the second signer in another browser profile or on the phone. Not yet measured live.
- **A split-key account (e.g. Blocto's 999 + 1) can't sign alone.** Check for one active key of weight ≥ 1000 (`GET /v1/accounts/{addr}?expand=keys`) before asking it to.

## Flow Wallet from a web page: account proof, linked accounts, and the hosts it calls (2026-10-03/04, PT)

Learned shipping the giveaway claim page and Deliver all (`lib/giveaways/claim-proof.ts`, `linked-accounts.ts`, `admin-wallet.ts`). Each was checked on mainnet.

- **Account proof (prove a wallet is the user's, no transaction):** set `fcl.accountProof.resolver` to return `{ nonce }` (≥ 64 hex) before `fcl.authenticate()`, and `unauthenticate()` first or a cached session comes back with no proof. The proof is in `user.services` (`type: "account-proof"`, `data: { address, nonce, signatures }`). FCL signs `window.location.origin` as the appIdentifier. Verify with `FCLCrypto.verifyAccountProofSignatures` at `0xb4b82a1c9d21d284`. The message is RLP `[appIdentifier, 8-byte address, nonce]` **without** the domain tag (the contract prepends `FCL-ACCOUNT-PROOF-V0.0`), byte-equal to `fcl.WalletUtils.encodeAccountProof(data, false)`. Using `verifyUserSignatures` instead checks a different message and always fails. Negative control: a forged signature returns `Bool false`. Positive control: Trevor's real Flow Wallet, 10-03.
- **Linked accounts:** use the parent's `HybridCustody.ManagerPublic.getChildAddresses()`, kept only where the child's own `OwnedAccountPublic.getRedeemedStatus(addr: parent) == true` (never `isChildOf`: an offered link counts there). The name comes from `manager.getChildAccountDisplay(address:)`, else the child's own `MetadataViews.Display` (Trevor's: "Dapper Wallet", "Creator Hub"). **Dapper = the account publishes `/public/dapperUtilityCoinReceiver`.** Decide it from that flag, never from the name.
- **Hosts a Flow Wallet signature calls from THE PAGE** (CSP `connect-src`): fcl-discovery, WalletConnect relay/verify/rpc, `wss://rest-mainnet.onflow.org` (seal watch), `*.wallet.flow.com` (pre-authz), and **`lilico.app`** (the fee payer, still on Flow Wallet's former domain); its logo is in `img-src`. Each missing host failed on iPhone as a bare "Load failed", one at a time. The page's network trace now names the host (`startNetworkTrace`).
- **Desktop extension (`EXT/RPC`) is unresolved:** see known-issues #172. Over WalletConnect (`WC/RPC`) the approval goes to the PHONE app, so a desktop page waiting on it shows nothing. The admin console now says which channel it's waiting on.

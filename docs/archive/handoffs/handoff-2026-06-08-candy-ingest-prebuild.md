# Candy ingest — pre-build spec (handoff Items 3–5)

Companion to docs/handoff-2026-06-08-candy-panini-onboarding.md. This pre-builds the Candy (Solana / Metaplex Core) ingest against the **real** DAS + Magic Eden response shapes (verified from docs 2026-06-08), so when Item 0 discovery lands the only fill-ins are 5 isolated TODOs. Claude Code's direct inspection wins over this doc; verify exact RPC column names via information_schema before writing, and verify the DAS/ME field names against a live response.

## Build posture: land it INERT now

It is safe to build + commit this now even though Candy has zero data yet:
- The `candy_mlb` collection row is `is_active=false` (id `209ade70-32c5-4470-bc7c-4793d660f713`) — nothing iterates it.
- **Do NOT wire any cron-job.org trigger** and **do NOT add a `pipeline_cadence_watchlist` row** until discovery + first successful manual run (an unrun watchlisted pipeline fires a false stall alert).
- Routes can exist unrun; they write only for `collection_id = 209ade70…`. tsc-clean is the bar. Revert = `git revert` + (if any rows were written in a test) delete where `collection_id = 209ade70…`.
- Keep `published:false` in the registry. Nothing user-facing changes.

This lands the ~70% that's knowable now; the 5 TODOs below are the discovery-gated ~30%.

## The 5 discovery TODOs (all resolved at Item 0, isolated to normalize + config)

1. `CANDY_MLB_COLLECTION_ADDRESS` — the Metaplex Core collection mint (group_value). Unknown until a live asset/wallet. Put in one config const.
2. `CANDY_MLB_ME_SYMBOL` — the Magic Eden collection symbol for the sales/listings endpoints. One config const.
3. `SERIAL_ATTR_KEY` — which `content.metadata.attributes[].trait_type` holds the on-chain serial number.
4. `EDITION_SIZE_ATTR_KEY` — which attribute holds the edition size / print run.
5. `editionKeyFromAsset(asset)` — how to derive the stable per-edition key (what groups serialized assets into one "card"/edition → `editions.external_id`). Candidates: a `set`+`card`/`playId`-style attribute pair, or a slug in `content.metadata.name`. Inspect 2–3 live assets in the same edition to confirm what's constant across serials.

Everything else below is final.

## Verified external shapes (2026-06-08)

### Helius DAS (through helius-proxy, POST with `X-Proxy-Secret`)
All three are JSON-RPC. Response: `{ result: { total, limit, page, items: [ asset, … ] } }` for the By* methods; `{ result: asset }` for getAsset. Each `asset` (interface `"MplCore"`):
- `id` — the asset **mint pubkey** (base58). This is the per-serial id → `wmc.moment_id`.
- `grouping` — `[{ group_key: "collection", group_value: "<COLLECTION_ADDR>" }]`.
- `content.json_uri` — Arweave metadata URL. `content.metadata.name`, `content.metadata.attributes` — `[{ trait_type, value }]` (serial, edition size, player, set live here). `content.files[].uri` / `content.links.image` — Arweave media → `thumbnail_url` / `video_url`.
- `ownership.owner` — Solana base58 owner → `wmc.wallet_address`.
- `royalty.basis_points`, `supply` — informational.

Methods:
- `getAssetsByGroup` `{ groupKey:"collection", groupValue:<addr>, page, limit:1000 }` — all editions' serials. Paginate page=1..N until `items.length < limit`.
- `getAssetsByOwner` `{ ownerAddress:<wallet>, page, limit:1000 }` — a wallet's holdings (filter to `grouping` collection == Candy).
- `getAsset` `{ id:<mint> }` — one asset (discovery / spot-checks).

### Magic Eden activities (sales) — GET `https://api-mainnet.magiceden.dev/v2/collections/{symbol}/activities?offset=0&limit=1000`
Returns an **array** of activity objects (verified OpenAPI):
- `signature` (string) — Solana tx sig → sales dedup key (`transaction_hash`).
- `type` (string) — activity kind. `"list"` = listing (NOT a sale). A completed sale is `"buyNow"` (confirm against live data; only ingest sale types into `sales`, route `"list"` to listings).
- `tokenMint` (string) — the NFT mint (= the serial; join to the edition via the same key derivation).
- `buyer` (string|null), `seller` (string|null).
- `price` (number) — in **SOL**. (`priceInfo.solPrice.rawAmount` + `decimals` for lamport precision.)
- `blockTime` (number, unix seconds) → `sold_at`. `slot`, `source` (e.g. `"magiceden_v2"`), `collectionSymbol`.
- Paginate with `offset` (max `limit` 1000). Free tier ~120 req/min — fine; set `MAGIC_EDEN_API_KEY` only if rate-limited.
- Listings (sniper/floor): GET `/collections/{symbol}/listings`; stats/floor: `/collections/{symbol}/stats`.

## Files to create

### lib/chains/solana/das.ts  (the read client)
A thin DAS client that POSTs through helius-proxy. Reads `process.env.HELIUS_PROXY_URL` + `HELIUS_PROXY_SECRET` (the worker is already deployed). Exports:
- `dasCall(method, params)` — POST `{jsonrpc:"2.0", id:1, method, params}` with header `X-Proxy-Secret: HELIUS_PROXY_SECRET`; return `result`. Throw on `error`.
- `getAssetsByGroup(collection, page=1, limit=1000)`, `getAssetsByOwner(owner, page=1, limit=1000)`, `getAsset(id)`.
- `paginateGroup(collection, onPage)` / `paginateOwner(...)` — loop pages until a short page; respect a max-page guard.
Mirror the Flow worker-call ergonomics in lib/chains/flow/. Keep the SOL→USD price helper here or in a shared util (see sales route).

### lib/chains/solana/normalize.ts  (the ONLY discovery-coupled file)
- `const CANDY_MLB_COLLECTION_ADDRESS = "TODO_1"` and `const CANDY_MLB_ME_SYMBOL = "TODO_2"`.
- `const SERIAL_ATTR_KEY = "TODO_3"`, `const EDITION_SIZE_ATTR_KEY = "TODO_4"`.
- `attrMap(asset)` — fold `content.metadata.attributes` into a `Record<trait_type,value>` (lowercase keys for safety).
- `editionKeyFromAsset(asset): string` — **TODO_5** derivation → the stable `editions.external_id`.
- `normalizeEdition(asset)` → `{ external_id, collection_id: CANDY_MLB_UUID, name, circulation_count: Number(attr[EDITION_SIZE_ATTR_KEY]) || null, thumbnail_url, video_url, player_name, set_name, tier? }`.
- `normalizeSerial(asset)` → `{ wallet_address: asset.ownership.owner, collection_id, moment_id: asset.id, edition_key: editionKeyFromAsset(asset), serial_number: Number(attr[SERIAL_ATTR_KEY]) || null, image_url }` — **invariant: `edition_key === editions.external_id`** (see memory wmc-edition-key-contract).
- `CANDY_MLB_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"`.

### app/api/ingest/candy-editions/route.ts  (Item 3 — editions + serials)
- Bearer-auth like the other ingest routes (`INGEST_SECRET_TOKEN`). `export const maxDuration = 300` (Pro cap is 800; never exceed). Fire-and-forget: `import { after } from "next/server"`, do the walk in `after()`, return 202.
- Walk `getAssetsByGroup(CANDY_MLB_COLLECTION_ADDRESS)`; for each asset upsert one `editions` row (dedup on `(external_id, collection_id)`) and one `wmc` row (dedup on `(wallet_address, collection_id, moment_id)`). Chunk upserts (≤500) like the existing FMV/ingest routes.
- Verify exact `editions` / `wmc` column names via information_schema before writing (don't trust this doc's field list blindly).
- Log a `pipeline_runs` row (pipeline `candy-editions-ingest`, ok flag, counts in `extra`) on both success + failure — the silent-stall guard (see memory rpc-silent-failure-class).

### app/api/candy-sales-indexer/route.ts  (Item 4 — sales)
- Same auth + `after()` + 202 pattern. Poll ME `activities` for `CANDY_MLB_ME_SYMBOL`, paginating by `offset` until you reach already-seen signatures (keep a cursor like the Flow indexers).
- For each **sale-type** activity (NOT `"list"`): write a `sales` row — `transaction_hash = signature` (dedup; sales is year-partitioned with a unique tx-hash index in sales_2026), `collection_id = CANDY_MLB_UUID`, `marketplace = "magic_eden"`, `source = "solana_das"`, `price_usd = price_SOL * solUsd(blockTime)`, `sold_at = new Date(blockTime*1000)`, buyer/seller, `nft_id`/mint = tokenMint. Confirm exact `sales` columns via information_schema first.
- SOL→USD: reuse any existing FX helper if present; else a simple cached spot (CoinGecko/Pyth) keyed by day. Mark `price_usd` honestly (note the SOL→USD basis).
- Optionally upsert ME `listings` into `cached_listings_v2` (`source = "magic_eden"`) for sniper/floor — can be a follow-up.
- `pipeline_runs` log on success + failure.

### app/api/wallet-backfill-candy/route.ts  (Item 5 — wallet holdings)
- `getAssetsByOwner(wallet)` filtered to the Candy collection → upsert `wmc` rows for that wallet (same shape as Item 3's serial upsert). `?force=true` bypass like the Flow backfills. This is what makes a pasted Candy wallet resolve once the per-surface validators flip (readiness GAP 1).

## FMV (Item 6) — no new code
Point the existing `fmv-recalc` engine at `CANDY_MLB_UUID` once editions + sales exist (chain-implicit via collection_id; do not rewrite pricing). Expect LOW/sparse confidence on a thin fresh book — correct, not a bug; never auto-promote zero-sale editions to ASK_ONLY.

## Wiring left for discovery / launch (do NOT do now)
- Fill the 5 TODOs from a live asset.
- One manual run of each route; verify counts; THEN add cron-job.org triggers (own stagger slot, off the :00 rush) + the `pipeline_cadence_watchlist` rows.
- Flip `is_active=true` + registry `published:true` + pages/brand/OG/sitemap (Item 7) — run the rpc-insights-qa checklist first.
- Flip the readiness GAP-1 validators to `isValidAddressForChain(addr, collection.dbChain)` on the Candy-reachable surfaces, each with its resolver (see docs/handoff-2026-06-08-candy-readiness-gaps.md).

## Guardrails
Direct-to-main, no branches/PRs. PowerShell git on Windows; re-verify push `git rev-list --count origin/main..HEAD` = 0. maxDuration ≤ 800. Full-file writes (CRLF). No secret values in commits/logs. NxGen `$CAND` disambiguation — only index assets under Candy Digital's verified collection/update authority.

## Expected end state (if landed now)
A commit on main, deploy READY, tsc-clean: `lib/chains/solana/{das,normalize}.ts` + three inert ingest routes that compile and are wired to `CANDY_MLB_UUID`, doing nothing until the 5 TODOs are filled and a cron is attached. Candy ships in hours, not days, once your assets hit Solana.

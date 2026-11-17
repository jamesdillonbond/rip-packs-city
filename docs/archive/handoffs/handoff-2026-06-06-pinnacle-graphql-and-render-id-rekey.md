# Handoff — Pinnacle live data source FOUND + a render_id key-granularity bug (overturns the "images dead-end")

## TL;DR

A Chrome spike on disneypinnacle.com (public marketplace, no login) found that **Dapper's studio-platform GraphQL is reachable from our datacenter IPs, unauthenticated** — and it carries the entire Pinnacle catalog: editions, NFTs, listings (floor ask), sales history, serials, render_id, and media URLs. This overturns the prior "Pinnacle images are a dead-end" conclusion (that was true on-chain + via the retired public-api, but NOT via this endpoint).

It also surfaced a **structural data bug**: RPC's `pinnacle_editions.edition_key` = `royalty_code:variant:printing` is **set-level, not pin-level**, so it collapses many distinct pins into one row. RPC has **320 distinct edition_keys for 2,079 real Dapper editions (~6.5x under-resolution)**. Example: `WDAS-SEV1-MNF:Standard:1` is ONE RPC row ("Daisy Duck") but SIX distinct characters on-chain (Daisy, Minnie, Pluto, Goofy, Donald, Mickey). The true unique key is **`render_id`** (e.g. `SEV1-MNF-DAIS-S1`). This is why per-pin images/FMV never worked — the row identity itself is wrong.

I did NOT change any schema or write images (the right fix is a re-key, which is Trevor's call + a careful CC migration). Everything below is the recipe + evidence.

## The endpoint

- URL: `https://api.production.studio-platform.dapperlabs.com/graphql` (POST). No auth. Send header `Origin: https://disneypinnacle.com`.
- Reachable from datacenter (Vercel/Supabase egress should work — verified HTTP 200 from the sandbox). The `assets.disneypinnacle.com` CDN 403s datacenter IPs, but real user browsers load it fine, and our existing `pinnacle-proxy` worker can fetch it if server-side bytes are ever needed.
- Relevant query fields: `searchPinnacleEditions`, `searchPinnacleNft`, `searchPinnacleMarketplaceHistory`, `searchPinnacleNftAggregation`.

### Working query shapes (verified live)

Editions (catalog + render_id + media + royalty for key-mapping):
`searchPinnacleEditions(searchInput:{ first:30, after:<cursor>, filters:[...] }){ totalCount pageInfo{endCursor hasNextPage} edges{ node{ id render_id variant printing total_minted edition_type tier{...} shape{ name render_id metadata{ royalty_codes characters franchises } } set{ name } medias{ name url } } nftCounts{ total owned } } }`
- `medias[].name` includes `Front_Transparent` (still PNG `.../render/<render_id>/front.png`), `Front_Quarter_Transparent` (`main.png`), and animated `.webp` (`front_anim.webp`, `360_anim.webp`, `idle_anim.webp`).
- Total editions = 2,079. Page with `first` + `pageInfo.endCursor`.

Floor ask for an edition (live lowest listing):
`searchPinnacleNft(searchInput:{ first:5, filters:[{edition:{shape:{name:{in:["Spinning Wheel"]}}}},{listing:{price:{gte:1}}}], sortBy:{ listing:{ price:{ priority:1, direction:"ASC" } } } }){ totalCount edges{ node{ serial_number owner_address listing{ price storefront_address } edition{ id render_id } } } }`
- GOTCHA: a `Sort` is the INPUT_OBJECT `{priority:Int!, direction:Direction!, missing:SortMissing}`, NOT an enum — `{price:"ASC"}` errors with "must be a Sort". Use `{price:{priority:1,direction:"ASC"}}`.
- **`listing.price` is UFix64 ×1e8** — divide by 1e8 for USD. Verified: Spinning Wheel floor `16500000000` = $165.00.
- `serial_number` is on every NFT → this is also the cleanest Pinnacle **serial** source (no Cadence needed; supersedes item 4 of handoff-2026-06-05).

Sales history: `searchPinnacleMarketplaceHistory(searchInput:{...})` (same filter/sort shape) for recent sale prices + dates.

## Finding 1 — the render_id key-granularity bug (HIGH IMPACT, structural)

Evidence: `pinnacle_editions` = 480 rows / **320 distinct edition_keys**; Dapper catalog = **2,079 editions**. The `WDAS-SEV1-MNF:Standard:1` key = 1 RPC row but 6 on-chain shapes. Because `edition_key = royalty_codes[0]:variant:printing` and `royalty_codes` is per-SET, every set with multiple shapes at the same (variant, printing) collapses to one RPC row — keeping one character's name and (at best) one character's art, silently wrong for the rest. `wmc` joins on this key, so a holder's pin can render the wrong character/image/FMV.

Recommended fix (CC, needs Trevor's sign-off — it's a catalog re-key):
1. Add `render_id` to `pinnacle_editions` (unique per pin) and backfill it from `searchPinnacleEditions` (page all 2,079). Make `render_id` the real identity; keep `edition_key` as a coarse secondary.
2. Re-map `wallet_moments_cache` Pinnacle rows to render_id. The on-chain `pinnacle-metadata-backfill` Cadence read already borrows each NFT and resolves its edition's shape → it can emit the per-NFT `render_id` (the NFT's `editionID` → `getEdition` → `shapeID` → shape `render_id`); store render_id on the wmc row so each held pin resolves to its specific shape, not the set bucket.
3. Re-derive `character_name` (shape.name), `thumbnail_url` (see Finding 2), `serial_number`, FMV per render_id.
4. Expected: RPC Pinnacle catalog goes from ~320 → ~2,079 correctly-identified editions.

## Finding 2 — Pinnacle images ARE recoverable (per render_id)

Each edition's art = `https://assets.disneypinnacle.com/render/<render_id>/front.png` (and `main.png`, animated `.webp`). Verified distinct per render_id (30/30 unique in a sample). These are valid public URLs that load in a user's browser (only datacenter IPs get 403, which doesn't matter for `<img src>` the user renders). After the re-key (Finding 1), populate `pinnacle_editions.thumbnail_url` from render_id, then `populate_wmc_image` denormalizes it. CRITICAL: this only works once rows are keyed by render_id — populating images on the collapsed keys reproduces the wrong-art problem (and is how the generic `pinnacle.jpg` got onto 19,316 wmc rows earlier). Validate DISTINCTNESS (count distinct URLs vs editions) before any bulk write.

## Finding 3 — FMV vs low-ask spot-check (per Trevor's ask)

- RPC's stored Pinnacle **asks are accurate**: Spinning Wheel RPC ask $165.00 = live GraphQL floor `16500000000`/1e8 = $165.00 = on-site "$165". The `pinnacle-listings-indexer` is trustworthy.
- RPC **FMV runs above the live floor on thin-traded legendaries**: Spinning Wheel FMV $247.22 (HIGH) vs floor $165 / last sale $188 (+50% over floor); Simba Lion King Vol.2 FMV $106.71 vs ask $49 / last sale $175 (wide). This is the sales-WAP-vs-current-floor gap — honest, not a bug, but for illiquid Pinnacle the floor ask is often the better "what it's worth right now" signal.
- Recommendation: where FMV >> floor ask (e.g. ratio > 1.3) on thin Pinnacle editions, surface the floor ask alongside FMV (RPC already computes `cross_market_ask` but doesn't surface it). Don't inflate FMV; if anything it should lean toward the ask when the two diverge on low liquidity.
- Variant-matching is critical: "Cinderella" Digital Display (supply 211, ~$275–339 recent sales, currently 0 listings) vs Silver Sparkle (supply 1096, ~$2–3). Conflating variants is a ~100x error — the render_id re-key fixes this cleanly.

## What I did / didn't do
- Did: the spike (read-only public data), verified the endpoint + queries + the bug + image URLs + FMV cross-check. No schema/data writes from this spike.
- Didn't: re-key the catalog or write images — that's a structural migration needing Trevor's call. Dumbo's Pinnacle images correctly stay NULL until the re-key (better than wrong art).

## Guardrails
- Read-only public GraphQL; keep it read-only. Route production fetches through `pinnacle-proxy` if/when server-side asset bytes are needed; user-browser `<img>` needs no proxy.
- Validate image distinctness before bulk writes. Re-key on render_id BEFORE repopulating images/FMV/character.
- Direct-to-main, PowerShell git, Cadence-MCP for any .cdc change — usual rules.

## End state
RPC gains a live, datacenter-reachable Pinnacle data source (catalog, floor, sales, serials, art) it wasn't using; the catalog gets re-keyed on render_id (~320 → ~2,079 correct editions), which simultaneously fixes Pinnacle images, serials, per-pin FMV, and the wrong-character display — the entire Pinnacle data-quality tail in one structural fix.

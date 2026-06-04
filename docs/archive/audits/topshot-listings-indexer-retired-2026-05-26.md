# topshot-listings-indexer retired — 2026-05-26

## TL;DR

`topshot-listings-indexer` has been retired from the cadence watchlist (`is_active=false`). It was green-but-useless for ~10 days: ran every 15min, wrote zero rows every tick. Operator should also **delete the corresponding cron-job.org entry** for `POST /api/topshot-listings-indexer`.

TS listings continue to flow through `topshot-fmv-populate` (TS GQL `searchMarketplaceEditions` → `badge_editions.low_ask` + `highest_offer`) which is working: 3,010 editions, 2,601 with low_ask, 1,942 fresh in last 6h. That's the source the new `get_topshot_sniper_deals` RPC reads, so the Sniper + Market frontends are unaffected.

## Diagnosis

The route at `app/api/topshot-listings-indexer/route.ts` scans Flow REST for events on these types:

- `A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable`
- `A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted`

Then filters the event payloads where `nftType === A.0b2a3299cc857e29.TopShot.NFT` (excluding `PackNFT.NFT`).

Per `CLAUDE.md` "Flow/Cadence contract addresses" section:

> NFTStorefrontV2 (Dapper, TopShot PackNFT / Pinnacle / MFL packs only): `A.4eb8a10cb9f87357.NFTStorefrontV2`

So the storefront the indexer scans only carries **packs**, not **moments**. The filter `nftType === TopShot.NFT` matches zero events on this contract every tick because TopShot moments never list there — they list via Top Shot's own marketplace contract (or off-chain via TS's centralized listings cache that `searchMarketplaceEditions` reads).

The pipeline runs around 1,120 blocks per tick, sees 13-38 events pre-filter (the PackNFT + Pinnacle listings on the contract), correctly skips 4-14 as PackNFT, then loses the remainder to the `TopShot.NFT` filter that never matches. Net: 0 listings written. Confirmed by `pipeline_runs.extra.listings_available_count` and `listings_completed_count` both 0 every run since 2026-05-17.

## Why retiring instead of repointing

Repointing the indexer requires knowing **which contract actually emits TopShot moment listing events on-chain**. Candidates:

- The legacy Top Shot marketplace contract (historically `A.c1e4f4f4c4257510.Market.MomentListed` — Dapper merchant). Status unknown; may still be active or may have been deprecated.
- The Flowty NFTStorefrontV2 fork at `0x3cdbb3d569211ff3` — but `CLAUDE.md` says it's dormant since 2026-05-14 (when Flowty shut down). Golazos + UFC indexers still write rows there, so it's not fully dormant, but TS coverage is uncertain.
- A bespoke Top Shot marketplace contract not yet identified.

Determining the right contract address requires Flow blockchain explorer access (e.g. flowscan.org) + reviewing Top Shot's contract source. That's a research task, not a code change.

In the meantime, retiring the broken pipeline:

1. Stops the false-positive alarm from `pipeline_cadence_watchlist`.
2. Aligns the watchlist row with reality (the pipeline isn't expected to write rows).
3. Removes 96 wasted cron firings per day.
4. Doesn't break any frontend — `cached_listings_v2` had 0 TS rows before, and 0 after.

## Migration applied

`audit_20260526_retire_topshot_listings_indexer` — sets `is_active=false` on the `topshot-listings-indexer` watchlist row and prepends a `[RETIRED 2026-05-26 …]` marker to its `notes` field.

## Operator follow-up

- Delete the cron-job.org entry for `POST /api/topshot-listings-indexer`.
- (Optional, low-priority) Research the correct TS moment-marketplace contract address. If found, write a new `topshot-listings-indexer-v2` against that contract, write to `cached_listings_v2 source='direct'`, and rebuild `get_topshot_sniper_deals` to prefer per-listing rows over the `badge_editions` edition-level aggregate.

Until that research happens, edition-level deals from `badge_editions` is the canonical TS feed shape.

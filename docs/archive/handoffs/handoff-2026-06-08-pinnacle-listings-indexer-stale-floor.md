# Handoff 2026-06-08 — Pinnacle listings indexer silently dropping new listings (stale floor)

Found by Cowork while chasing the post-retirement `pinnacle-listing-cache rows_written:0` loose end. NOT caused by the FMV retirement (pre-existing since ~2026-05-27). Route/worker code → CC. Per-render FMV is UNAFFECTED; only the listings-derived ASK/floor is stale.

---

## RESOLVED 2026-06-08 (Claude Code, commit `04011b3`) — premise corrected; real bug was the concierge

CC investigation against live DB found the headline premise ("floor frozen 12 days, every freshness signal lies") **substantially wrong**, and the indexer diagnosis off. Corrected picture:

- **The live per-pin floor sources are fresh.** `pinnacle_catalog.floor_ask` (render-keyed, the canonical per-pin floor) refreshes daily from the **studio GraphQL** via `backfill-pinnacle-catalog` (1,963 priced, 06-08 09:37). `pinnacle_editions.ask_price` refreshes every ~15 min via the **on-chain** `pinnacle-listings-reconcile` (`ask_source='pinnacle_direct'`, from `pinnacle_listing_events`, which is fresh — 390 ingested/24h). `cached_listings_v2` (the indexer's own output) is fresh too (4,684 open, 06-08 22:24).
- **The indexer is NOT dropping listings.** It writes every `ListingAvailable` to `cached_listings_v2` regardless; `edition_key_unmapped`/`cadence_capped` only mean the `edition_id` *UUID* stays null — structurally expected for Pinnacle (it never lives in the shared `editions` table). No floor is lost there. The handoff's render-path re-point was unnecessary — and the sample nft_ids actually resolve cleanly via `pinnacle_nft_map.edition_key` (integer studio id, e.g. `1742`) = `pinnacle_catalog.edition_id` → render.
- **The one genuinely frozen table is `pinnacle_cached_listings`** (141 rows, 05-27) — because `pinnacle-listing-cache` fetches from **dead Flowty** (shut 2026-05-13, now serving a frozen snapshot). That table fed the only real bugs:
  - **User-facing:** the AI concierge deal-finders (`searchPinnacleDeals` + `searchPinnacleByName`, `lib/concierge/pinnacle-router.ts`) read ask/buy_url from that frozen Flowty cache and computed `discount_pct` vs *fresh* per-render FMV → fabricated discounts off stale / uniform-$1 asks.
  - **Minor:** `pinnacle_refresh_editions_ask()` (called by `pinnacle-listing-cache` + `pinnacle-sync`) re-stamped 37 `pinnacle_editions.ask_price` rows (`ask_source='pinnacle_marketplace'`) from the same frozen Flowty data — and `pinnacle_editions.ask_price` is set-level keyed anyway (per-pin wrong; superseded by `pinnacle_catalog.floor_ask`).

### Shipped (commit `04011b3`)
1. **Concierge → per-render spine.** Both `searchPinnacleDeals` and `searchPinnacleByName` now read `pinnacle_catalog` (floor_ask + fmv_usd on the same render row; buy_url → `PINNACLE_MARKETPLACE_URL`). Ask, FMV, and discount stay on one pin — no cross-character leak, no dead-Flowty dependency. Removed the now-dead `fetchFmvByListingTriples`/`tripleKey`/`charKey` helpers. Smoke tests (`searchPinnacleDeals` character-filter + FMV-leak guard) pass trivially.
2. **Flowty teardown.** `pinnacle-listing-cache` is now an inert auth-gated no-op (logs a healthy `pipeline_runs` row so the cron stays green until the operator removes the schedule); it no longer fetches Flowty, writes `pinnacle_cached_listings`, or calls `pinnacle_refresh_editions_ask`. Removed that same `pinnacle_refresh_editions_ask` call from `pinnacle-sync`. The on-chain `pinnacle-listings-reconcile` (`ask_source='pinnacle_direct'`) is now the sole `pinnacle_editions.ask_price` writer.
3. **DB cleanup:** nulled the 37 stale `ask_source='pinnacle_marketplace'` rows on `pinnacle_editions`.

### Operator follow-ups (not code)
- Remove the cron-job.org entry for `pinnacle-listing-cache` (route is now a retired no-op), then the route file can be deleted.
- Optional sentinel (the handoff's suggestion, re-aimed at the *real* source): alert if `pinnacle_listing_events` newest `listed_at` (or the on-chain `pinnacle_direct` `ask_updated_at`) goes stale while Pinnacle sales are active — the dead-Flowty `pinnacle_cached_listings.listed_at` check the handoff proposed is moot now that that path is retired.

### Revert
`git revert 04011b3`. The 37 nulled asks re-populate from the on-chain reconcile on its next tick for any edition with a live listing.

## The finding (MED — silent, ~12 days, ongoing)

Pinnacle ASK/floor prices have been frozen at a 2026-05-27 snapshot for ~12 days while the marketplace is active, and every freshness signal lies about it:
- `pinnacle-listings-indexer` runs every ~20min and logs `ok=true` (72/24h), but `pinnacle_cached_listings.listed_at` newest = **2026-05-27 01:34** (`cached_at` is fresh because the indexer re-touches the same 141 old rows).
- Meanwhile Pinnacle is busy: **526 sales in 7d**, newest sale 06-08 21:43, 1,039 sales since 05-27. A sale implies a listing existed — so new listings are happening and being missed.
- `pinnacle_refresh_editions_ask()` (the relocated ASK leg now called by pinnacle-listing-cache) reads `pinnacle_cached_listings` and stamps `pinnacle_editions.ask_price` + `ask_updated_at = NOW()` on every run — so `ask_updated_at` looks current (06-08 22:17) even though the underlying listings are 12 days old. Classic silent-degradation: green pipeline, fresh-looking timestamp, stale data.

Impact: Pinnacle floor/ask is wrong on the pin pages, the FMV-vs-floor callout, and the cross-collection deals board (Pinnacle rows). FMV itself (sales-based, per-render `pinnacle_catalog.fmv_*`) is fresh and correct — this is the secondary ASK signal only.

## Root cause (pinpointed)

The indexer's per-run `extra` shows it IS seeing new listings but dropping them: `listings_available_count` > 0 with `failure_reason_counts: {edition_key_unmapped: N}` dominating (e.g. 21:45 run: 8 available, 7 `edition_key_unmapped`).

Traced the unmapped path with 5 sample unresolved nft_ids (`63771676971665, 56075095571288, 216603793227106, 240793049047875, 123145304865590`):
- All 5 ARE in `pinnacle_nft_map` (so it's not a missing-NFT problem), and 4/5 have sales.
- `pinnacle_nft_map` maps them to integer `edition_key`s `1742 / 1787 / 1771 / 1743 / 1786`.
- **None of those edition_keys exist in `pinnacle_editions.edition_key` NOR in `pinnacle_catalog.legacy_edition_key`** (verified — all `false`).

So the chain is: listing event → nft_id → `pinnacle_nft_map.edition_key` (e.g. `1742`) → lookup in `pinnacle_editions` → NOT FOUND → `edition_key_unmapped` → drop. It's a keying-scheme mismatch: `pinnacle_nft_map` carries old plain-integer edition_keys, but `pinnacle_editions` uses the composite `royalty_code:variant_type:printing` scheme and the live FMV home is per-render `pinnacle_catalog` (render_id PK). This is almost certainly fallout from the render_id re-keying — the listings indexer's edition resolution wasn't migrated to the per-render scheme.

## Fix direction (CC — the indexer is route/worker code Cowork can't see fully)

1. Re-point the indexer's edition resolution at the per-render scheme: resolve listing nft_id → render_id → `pinnacle_catalog` (the same spine the FMV engine + wmc now use), instead of `pinnacle_nft_map.edition_key` → `pinnacle_editions`. The nft→render mapping likely already exists (wmc.render_id / the pinnacle metadata backfill); confirm and use it.
2. Alternatively/additionally, reconcile `pinnacle_nft_map.edition_key` to whatever `pinnacle_editions`/`pinnacle_catalog` key on now — but the per-render path (#1) is the durable one since that's where Pinnacle data lives post-rekey.
3. Backfill: once resolution is fixed, the open-listings cache repopulates on the next ticks; `pinnacle_refresh_editions_ask` then writes real current floors. Spot-check `pinnacle_cached_listings.listed_at` advances past 05-27 and a few pin pages show updated floors.

## Also recommend (sentinel — this hid for 12 days)
Add a freshness check that would have caught this: alert when `max(pinnacle_cached_listings.listed_at)` (NOT cached_at) is older than ~24-48h while Pinnacle sales are active, OR when the indexer's `edition_key_unmapped` rate exceeds a threshold over a window. The existing cadence watchlist keys on run-cadence, which stayed green here.

## Not Cowork-shipped
The fix is in the listings-indexer route/worker (edition resolution logic) — CC's domain. This doc is the diagnosis + samples so CC can go straight to the resolution path. CC's file inspection wins over this doc.

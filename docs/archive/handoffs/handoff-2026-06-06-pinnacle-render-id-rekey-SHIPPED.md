# Pinnacle render_id re-key — SHIPPED (2026-06-06, Claude Code)

Executes the 2026-06-06 "Pinnacle live data source + render_id key-granularity"
handoff. Trevor approved the full re-key (new isolated table). Worked autonomously
overnight. Commit `2e8cbd1` on `main`.

## What the spike found (all re-verified live this session)
- **Live datacenter-reachable source:** `https://api.production.studio-platform.dapperlabs.com/graphql`,
  unauthenticated, requires header `Origin: https://disneypinnacle.com`. Carries
  the full Pinnacle catalog (editions, NFTs, listings/floor, sales history,
  serials, render_id, media). Verified 200 from our egress; `totalCount = 2079`.
- **Structural bug:** the legacy `pinnacle_editions.edition_key`
  (`royalty_code:variant:printing`) is **set-level**, collapsing distinct pins.
  2,079 real editions reduced to **337** legacy keys (DB had only 320). Worst
  case: `STAR-OEV1-SWAL:Standard:1` = ONE row hiding **26** Star Wars characters.
- **The true per-pin key is `render_id`** (e.g. `OEV1-SOUL-JGAR-S2`).

## Shipped — DB (applied live via Supabase connector, NOT repo migration files)
1. **`pinnacle_catalog`** (new, isolated, render_id PK) — migration
   `create_pinnacle_catalog_render_id_keyed`. Seeded with **all 2,079 editions**
   via `scripts/seed-pinnacle-catalog.mjs`: render_id, edition_id, shape_render_id,
   character_name (shape.name), set_name, variant, printing, total_minted,
   edition_type, series_name, royalty_codes/franchises/characters, color/effects/
   materials/size/thickness, is_chaser, legacy_edition_key (bridge), thumbnail_url
   (proxy path), front_anim_url. RLS on, anon/auth SELECT, service_role write.
   Verified: 2,079 rows / 2,079 distinct render_ids / 2,079 distinct image URLs.
2. **`wallet_moments_cache.render_id`** column + partial index — migration
   `wmc_add_render_id_and_remap_staging` (also created staging table
   `pinnacle_wmc_remap`, kept as an audit trail).
3. **wmc re-key applied** (via `scripts/remap-pinnacle-wmc.mjs` by-NFT-id GraphQL
   → staging → `UPDATE FROM`):
   - render_id set on **all 36,405** Pinnacle wmc rows (0 null, 0 unresolved nft ids).
   - **33,344 wrong characters corrected (91.6%)** — e.g. NFT `278176442649188`
     was "Mr. Mittens", is actually **"Joe Gardner"** (`OEV1-SOUL-JGAR-S2`).
   - serials filled where serialized (85 net; most Pinnacle pins are open/non-serial → null is correct).
   - character_name/set_name/mint_count re-derived from `pinnacle_catalog`.
4. **`derive_pinnacle_wmc_from_catalog()`** SECDEF fn (service_role) — idempotent
   catalog→wmc derivation (character/set/mint/image). Called by the freshness cron.
5. **`populate_wmc_image`** repointed: its Pinnacle branch now sources
   `pinnacle_catalog` by render_id (was the coarse `pinnacle_editions`, placeholder-excluded → filled nothing).

## Shipped — code (commit `2e8cbd1`)
- **`/api/public/pinnacle-image/[renderId]`** — gate-free image resolver. The
  Dapper CDN serves only SIGNED short-lived URLs and 403s any unsigned/datacenter
  request (confirmed: even a fake render_id 403s, so a bare URL can't be validated
  or stored durably). This route fetches a FRESH signed media URL server-side and
  302-redirects the browser to it (Cache-Control s-maxage=1800 < signature TTL).
  Public (under /api/public, anon-bypassed). `?v=quarter` for main.png.
- **`/api/admin/backfill-pinnacle-catalog`** — daily catalog freshness (Bearer
  RPC_ADMIN_TOKEN). Pages searchPinnacleEditions, upserts pinnacle_catalog.
- **`/api/cron/pinnacle-wmc-render-id`** — hourly; resolves new pins (render_id
  NULL) by-NFT-id and calls the derive fn (Bearer INGEST_SECRET_TOKEN).
- **`scripts/{seed-pinnacle-catalog,remap-pinnacle-wmc}.mjs`** — initial bulk loads.

## Image flip
After the deploy reaches READY and the image route is confirmed live,
`derive_pinnacle_wmc_from_catalog()` was run to set `wmc.image_url` to the proxy
path for all Pinnacle rows — fixes the placeholder tiles on /share, dashboard,
and `get_wallet_collection_snapshot` (those surfaces already render `image_url`,
so no frontend change was needed for the wallet/share image win).

## OPERATOR follow-ups (cron-job.org)
- Add daily `https://www.rippackscity.com/api/admin/backfill-pinnacle-catalog?token=<RPC_ADMIN_TOKEN>`.
- Add hourly `https://www.rippackscity.com/api/cron/pinnacle-wmc-render-id?token=<INGEST_SECRET_TOKEN>`.
- (Use www — apex 308-redirects.)

## DEFERRED follow-ups (documented, need their own pass)
- **FMV per render_id.** Pinnacle FMV (`pinnacle_fmv_snapshots`) is still computed
  on the coarse edition. True per-render FMV needs a sales-history ingest from the
  GraphQL `searchPinnacleMarketplaceHistory` (per render_id), then a recompute.
  Until then per-pin FMV inherits the coarse value.
- **Pinnacle per-pin page + scarcity board cutover.** `app/pinnacle/moment/[id]/page.tsx`
  is keyed on the coarse `pinnacle_editions.id` (one id → many render_ids now) via
  `get_pinnacle_moment_detail`, and `/insights/pinnacle-scarcity` links to it.
  Re-key both to render_id + `pinnacle_catalog`, render the image via the proxy
  route, and (with the FMV pipeline above) show per-pin FMV. Left coarse rather
  than half-cut.
- **Floor-ask vs FMV surfacing** (handoff Finding 3): where FMV >> floor on thin
  editions, lean the displayed "what it's worth now" toward the floor ask. RPC
  already computes `cross_market_ask` but doesn't surface it.
- **The old `pinnacle-metadata-backfill` Cadence route** still runs and writes the
  coarse `pinnacle_editions`. It's now superseded by the GraphQL catalog for
  character/image/serial but is harmless (different table). Consider retiring its
  Q1–Q5 once readers are fully on render_id. (Note: its `b6005cb` Cadence read had
  a regression flagged in the 2026-06-06 monitor inbox — unrelated to this work.)

## Rollback
- Code: `git revert 2e8cbd1`.
- DB (only if abandoning): `DROP TABLE pinnacle_catalog, pinnacle_wmc_remap;`
  `ALTER TABLE wallet_moments_cache DROP COLUMN render_id;`
  `DROP FUNCTION derive_pinnacle_wmc_from_catalog();` and re-CREATE the prior
  `populate_wmc_image` body (Pinnacle branch joining `pinnacle_editions`).
  The wmc character/set corrections would need the prior Cadence backfill to
  re-run to revert (not recommended — the new values are correct).

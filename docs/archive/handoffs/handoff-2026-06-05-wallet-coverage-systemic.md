# Handoff — wallet-coverage systemic fixes (wire Cowork's DB work + finish the GQL/Cadence/browser parts)

## Context — what Cowork already shipped live (DB)

Two coverage fixes are LIVE in Supabase `bxcqstmqfzmuolpuynti` (no code, just data + one function):

- **AllDay mint counts unblocked.** Discovery: `editions.circulation_count` is populated for 6,190/6,191 AllDay editions — the long-standing "AllDay has no circulation" note in CLAUDE.md / memory is STALE. The "0/27" mint gap was just a missed wmc denorm. Backfilled it for Dumbo (`0x37a7e864611c7a85`) → 27/27. The platform-wide denorm is item 2 below.
- **`populate_wmc_image(p_collection_id uuid, p_force boolean, p_limit int)`** — new SECURITY DEFINER fn (service_role only), sibling to `populate_wmc_fmv_from_snapshots`. Nothing ever populated `wmc.image_url`, so `/share` + `get_wallet_collection_snapshot` rendered placeholder tiles on fresh-warmed wallets. It denormalizes `editions.thumbnail_url` (TS/AllDay/Golazos/UFC) and `pinnacle_editions.thumbnail_url WHERE LIKE 'http%'` (Pinnacle) into `wmc.image_url`, http-only, NULL-only by default. Ran it: ~139k rows imaged so far, but only **8.8% of 1.58M wmc rows** are imaged — large backlog remains (see item 1).

No commit needed for those — they're applied. Everything below is route/Cadence/worker code that Cowork can't push.

## Item 1 — wire `populate_wmc_image` into the cron + add a partial index

- `app/api/wmc-fmv-populate/route.ts` already loops published collections calling `populate_wmc_fmv_from_snapshots`. Add a parallel call to `populate_wmc_image(collection_id, false, 50000)` per collection in the same loop (or a sibling cron). NULL-only drains ~50k/collection/tick.
- Add a partial index so the NULL-only scan stays fast as the backlog shrinks (I hit statement timeouts on the unindexed scan once the easy rows were gone):
  CREATE INDEX CONCURRENTLY idx_wmc_image_url_null ON public.wallet_moments_cache (collection_id, edition_key) WHERE image_url IS NULL;
  Must be standalone `execute_sql`, NOT inside `apply_migration` (CLAUDE.md). Backlog ≈ 1.4M rows → ~a day or two of ticks; the index can be dropped once it's drained.
- Also have the warm path / new-wallet onboarding call `populate_wmc_image` after a backfill (same place `populate_wmc_fmv_from_snapshots` is triggered) so fresh wallets get images immediately, not on the next cron tick.

## Item 2 — AllDay mint counts, platform-wide

Data is ready (`editions.circulation_count`). Backfill all AllDay wmc:
  UPDATE wallet_moments_cache wmc SET mint_count = e.circulation_count
  FROM editions e
  WHERE wmc.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND e.collection_id = wmc.collection_id AND e.external_id = wmc.edition_key
    AND wmc.mint_count IS NULL AND e.circulation_count IS NOT NULL;
CHUNK it (LIMIT by id batches or per-wallet) — the unscoped UPDATE will hit the statement timeout on the full AllDay wmc population. Then fold the same join into the AllDay warm/refresh so it stays current. Update the stale "AllDay has no circulation" lines in CLAUDE.md + the rpc-allday-data-parity-gaps memory.

## Item 3 — FMV drift (displayed FMV lags snapshot changes)

`wmc.fmv_usd` lags because the cron's populate is NULL-only; force mode re-evals everything (heavy on TS's 1.17M rows). Add a targeted refresh:
- Design a `refresh_wmc_fmv_changed(p_since_minutes int, p_limit int)` SECDEF fn: latest snapshot per (collection_id, external_id) where `computed_at >= now() - p_since`, joined to wmc, update `fmv_usd` where DISTINCT. Mirror `populate_wmc_image`'s security (REVOKE PUBLIC/anon/authenticated; GRANT service_role).
- BEFORE shipping, confirm `fmv_snapshots` has a `computed_at` index to support the window scan (per-partition) — if not, add it CONCURRENTLY. Test perf on a small window first; the unindexed-scan timeout class bit me on wmc, same risk here.
- Wire to the cron every 20min with `p_since_minutes=30`. (Simplest fallback if the recent-scan is slow: a chunked daily `populate_wmc_fmv_from_snapshots(collection, force:=true, 50000)` pass.)
- This is what ends the manual re-syncing I've been doing on Dumbo's wallet.

## Item 4 — Pinnacle serials (on-chain Cadence)

NOT recoverable from the DB (0 of his missing serials are in `pinnacle_sales`). Extend the Cadence read you JUST added in `app/api/cron/pinnacle-metadata-backfill/route.ts`: the script already borrows each NFT (`cap.borrowNFT(id)! as! &Pinnacle.NFT`). Verify via the Cadence MCP whether `Pinnacle.NFT` exposes a per-NFT serial / mint-number field (e.g. `serialNumber`); if so, add it to the returned struct and a job that fills `wmc.serial_number` for Pinnacle rows where it's NULL. His coverage is 7/202; platform-wide same gap.

## Item 5 — Pinnacle images: the web-API spike (biggest visible gap)

The prior handoff (docs/handoff-2026-06-04-pinnacle-image-catalog-backfill.md, shipped `373967d`/`69d5c6e`) PROVED the on-chain image dead-end (generic thumbnail + non-unique `renderID`). The ONE unexplored avenue: `public-api.disneypinnacle.com` returns **404, not 403** — that smells like a moved/retired endpoint, not datacenter-IP blocking. Spike: open the live disneypinnacle.com marketplace in Claude in Chrome, watch the network tab for the CURRENT API endpoint that serves per-edition art, and test whether it's reachable through a Cloudflare Worker (the same trick that beats Top Shot's edge block). If it serves per-edition images → build a thumbnail backfill (write `pinnacle_editions.thumbnail_url`, http-only, then `populate_wmc_image` denormalizes it). If it doesn't → Pinnacle art is truly exhausted; record it and stop. ~396 of 479 Pinnacle editions are NULL-thumbnail, so this is the single highest-impact image fix if it pans out.

## Guardrails

- Direct to `main`, no branch/PR. PowerShell `git` on Windows (Git Bash commit can silently no-op); re-verify with `git rev-list --count origin/main..HEAD` = 0.
- `CREATE INDEX CONCURRENTLY` is standalone `execute_sql`, never inside `apply_migration`.
- Every new SECDEF fn defaults to anon+authenticated EXECUTE — REVOKE from PUBLIC/anon/authenticated and GRANT only service_role (verify `proacl` = `{...,service_role=X/...}`, nothing else).
- Chunk big wmc UPDATEs (1.58M rows) — the unscoped version times out.
- Cadence MCP verification before editing the `.cdc` template literal.
- maxDuration stays as-is; never exceed 800.
- Your direct inspection + the Cadence MCP win over this doc — adapt.

## Verify (end state)

- `populate_wmc_image` called by the cron; `SELECT count(*) FILTER (WHERE image_url LIKE 'http%') FROM wallet_moments_cache` climbs from ~139k toward the imageable ceiling run-over-run.
- AllDay `wmc.mint_count` non-null across the AllDay population.
- (If shipped) `refresh_wmc_fmv_changed` keeps `wmc.fmv_usd` within minutes of the latest snapshot — no more manual re-syncs.
- Pinnacle `wmc.serial_number` coverage rises if item 4 lands; Pinnacle thumbnails rise if item 5's spike finds a source.

## End state

Cowork's two DB fixes (AllDay mints + image-populate fn) are live; this handoff wires the image fn + FMV-refresh into the cron, finishes the AllDay-mint and Pinnacle-serial backfills, and runs the one remaining Pinnacle-image spike — after which wallet coverage is at its true ceiling and the manual re-syncing stops for good.

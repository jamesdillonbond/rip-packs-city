<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Architecture notes

- FMV recalc v1.5.0 live (WAP + days_since_sale + sales_count_30d).
- TopShot sets catalog: the GQL editions-catalog creates `sets` rows keyed by the TopShot UUID (`external_id`) but does NOT populate `set_id_onchain`. `ensure_topshot_edition_stub` self-heals this on the set-lookup miss path — it bridges UUID→`set_id_onchain` via a sibling edition and backfills the `sets` row (migration `audit_20260523_ensure_topshot_edition_stub_self_heal`). New TopShot sets resolve with no manual seeding.
- Pack EV pipeline v11: queue-poisoning bug fixed — `topshot_pack_ev_targets` view filters zero-priced reward distributions; sentinel rows write to `pack_ev_history` on `pool_empty` with non-NULL `pack_ev` (0 works; view has `BETWEEN -10000 AND 1000000` filter). 0% pipeline failure rate across 23 active pipelines.
- WMC backfill (May 7): TS 99.8% tier / 100% set / 89.6% mint via `UPDATE FROM editions JOIN`. 18 RPCs read `wmc.tier` directly — backfill approach preferred over per-RPC patches. **AllDay mint counts are NOT a coverage gap (corrected 2026-06-05): `editions.circulation_count` is populated for 6190/6191 AllDay editions; the old "AllDay has no circulation" note was stale — it was just a missed wmc denorm. Backfilled `wmc.mint_count` platform-wide (AllDay now 324,510/324,590) and folded `mint_count = COALESCE(wmc.mint_count, e.circulation_count)` into `backfill_wmc_metadata_from_editions` (migration `audit_20260605_backfill_wmc_metadata_add_mint_count`) so the warm/refresh path keeps it current.**
- WMC image denorm (2026-06-05): `wmc.image_url` was never populated — `/share` + `get_wallet_collection_snapshot` rendered placeholder tiles. New SECDEF fn `populate_wmc_image(collection_id, force, limit)` denormalizes `editions.thumbnail_url` (TS/AllDay/Golazos/UFC) + `pinnacle_editions.thumbnail_url WHERE LIKE 'http%'` (Pinnacle), http-only, NULL-only by default. Wired into the `wmc-fmv-populate` cron loop (50k/collection/tick) backed by partial index `idx_wmc_image_url_null`. Pinnacle images are mostly a dead-end (no per-edition on-chain art — see [docs/handoff-2026-06-04-pinnacle-image-catalog-backfill.md]); the fn fills only the ~82 legacy-http Pinnacle thumbnails.
- Flowty analytics (May 6/7): `/admin/flowty-analytics` with `RPC_ADMIN_TOKEN`. 3 materialized views (`mv_flowty_sales/loans_daily`, `mv_flowty_first_activations`) + 5 RPCs (`flowty_top_{buyers, sellers, net_marketplace, lenders, borrowers}`). `refresh_flowty_analytics()` ~1s. UFC/Golazos at 0 in MV until spork. Pinnacle uses `pinnacle_sales` separately.
- GitHub Actions cron every 20min calling `/api/ingest` with `INGEST_SECRET_TOKEN` sourced from repo secrets.
- Watchlist + FMV Alerts: tables and API routes were applied during earlier sessions; the current concierge tool set does not include watchlist/alert tools, so the user-facing path is partially decommissioned. Verify table/route status before reactivating.
- Collection sharing: `/api/collection-snapshot` + `/share/[wallet]` with OG image generation.
- Unique index on `transaction_hash` in `sales_2026` (prevents duplicate wallet-seed rows).
- Flowty relationship: CEO Mike Levy, CTO Austin Kline — aware of and supportive of RPC.

---

## Beta users (current)

- jamesdillonbond — `0xbd94cade097e50ac` (Trevor)
- RipPacksCity — `0xb5053ef95e702657`
- samwise222 — `0xa3d67b29e104e701`
- Mike Levy — `0x11859edcf2f53edd`

Watch wallets at `priority=3` in `seeded_wallets`:
- roham — `0x01d7e57aa5598e47`
- rybaguy — `0xbe9c633840e40df3`

---



---

## Preserved from the 2026-08-17 CLAUDE.md restructure

> These lines were condensed or dropped in CLAUDE.md when it was cut to fit the memory-file
> char limit. They are kept here verbatim so nothing is lost.

### Code patterns dropped from CLAUDE.md

- Branch fragmentation is a recurring issue — consolidate with cherry-pick onto one canonical branch before merging.
- `project_knowledge_search` is NOT authoritative against live repo — Claude Code's direct file inspection wins every disagreement; prompts should allow Claude Code to correct false premises.

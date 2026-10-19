-- ✅ APPLIED 2026-10-18 10:06 PM PT (Cowork cloud, at Trevor's request to run the SQL updates): one-off pg_cron jobs
-- 753 (All Day UPDATE → `UPDATE 1`) and 754 (Pinnacle note UPDATE → `UPDATE 1`), both unscheduled after; read back via
-- v_collection_marketplace_status: All Day primary_venue = dapper_storefront_v2. The MCP's execute_sql cancelled the
-- multi-statement and DO-block forms; one statement per cron.schedule call went through. Kept as the record + revert.
--
-- PARKED 2026-10-18 ~5:10 PM PT (Claude Code cloud): apply_migration returned "timed out after 60s"
-- twice with no schema_migrations row and no backend in pg_stat_activity (the operator-confirmation
-- hold on data writes, tooling-gotchas.md). Not retried. Run in the SQL editor, or via apply_migration
-- with name audit_20261018_marketplace_status_allday_primary_venue_is_storefront_v2 and then commit
-- it as supabase/migrations/<version>_<that name>.sql (delete this file in the same commit).
--
-- WHY: v_collection_marketplace_status (lib/marketplace-status.ts; its `notes` is the tooltip of the
-- marketplace pill and the banner copy) says All Day's primary venue is V1 NFTStorefront and that
-- "V2 only carries Pinnacle/MFLPack/TopShot PackNFT" — verified 2026-05-18. Re-derived 2026-10-18
-- ~5:05 PM PT, the claim has inverted:
--   * sales, 14 d: onchain_dapper_v2 7,219 · offer_fill 264 · onchain_dapper_v1 92
--   * cached_listings_v2 open asks: direct_v2 11,018 · direct 8,467 · storefront_v2 4,899 (all adding
--     rows in the last 24 h) vs direct_v1 10,518 with 0 new in 24 h (newest 2026-09-18)
-- Pinnacle's row is still right but its numbers are from 05-18; re-stamped from the same instant
-- (280 new listings in 24 h, 29,723 open, pinnacle-listings-indexer 72/72 ok in 24 h).
-- Top Shot is deliberately NOT touched: its Flowty-dormant fact is #178's measurement and its
-- pack-secondary figure was not re-derived. Re-derive the numbers above before applying if this sits
-- more than a few days.
--
-- PRECONDITION (expect 'dapper_storefront_v1'):
--   select metadata #>> '{marketplace,primary_venue}' from collection_config where collection_id='dee28451-5d62-409e-a1ad-a83f763ac070';
--
-- REVERT:
--   update collection_config set metadata = jsonb_set(metadata,'{marketplace}', '{"notes": "V1 NFTStorefront is the actual primary venue — 173 sales captured + 360 listings since commit 7d7287f deploy. Earlier V2 NFTStorefrontV2 hypothesis (a7e3c2f) was disproven by diagnostic b7ed0c2 — V2 only carries Pinnacle/MFLPack/TopShot PackNFT typeIDs. AllDay pack secondary venue remains unknown.", "status": "healthy", "primary_venue": "dapper_storefront_v1", "secondary_venue": "flowty", "buy_ctas_enabled": true, "last_verified_at": "2026-05-18T18:00:00Z", "primary_contract": "A.4eb8a10cb9f87357.NFTStorefront", "secondary_status": "dormant_may14_2026", "pack_secondary_venue": "unknown_investigation_pending", "pack_secondary_contract": null}'::jsonb) where collection_id='dee28451-5d62-409e-a1ad-a83f763ac070';
--   update collection_config set metadata = jsonb_set(jsonb_set(metadata,'{marketplace,notes}', to_jsonb('Dapper V2 NFTStorefrontV2 healthy. 350 new listings ingested per 24h. pinnacle-listings-indexer covers via direct Flow REST events scan with nftType filter A.edf9df96c92f4595.Pinnacle.NFT.'::text)),'{marketplace,last_verified_at}', to_jsonb('2026-05-18T14:00:00Z'::text)) where collection_id='7dd9dd11-e8b6-45c4-ac99-71331f959714';

update collection_config
   set metadata = jsonb_set(jsonb_set(jsonb_set(jsonb_set(metadata,
         '{marketplace,primary_venue}', to_jsonb('dapper_storefront_v2'::text)),
         '{marketplace,primary_contract}', to_jsonb('A.4eb8a10cb9f87357.NFTStorefrontV2'::text)),
         '{marketplace,last_verified_at}', to_jsonb('2026-10-19T00:25:00Z'::text)),
         '{marketplace,notes}', to_jsonb('NFL All Day trades on Dapper''s NFTStorefrontV2 (nflallday.com + Dapper Market). Re-verified 2026-10-18 (PT): 14-day sales onchain_dapper_v2 7,219 vs onchain_dapper_v1 92 (plus 264 offer fills); open on-chain asks ~24k on V2 (direct_v2, storefront_v2, direct) while the V1 book (direct_v1) has added nothing since 2026-09-18. The 05-18 note calling V1 the primary venue had inverted. Flowty: listings still served, sales dormant since 2026-05-14 (#178). Pack secondary venue not established.'::text))
 where collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
   and metadata #>> '{marketplace,primary_venue}' = 'dapper_storefront_v1';

update collection_config
   set metadata = jsonb_set(jsonb_set(metadata,
         '{marketplace,notes}', to_jsonb('Dapper V2 NFTStorefrontV2 healthy. Re-verified 2026-10-18 (PT): 280 new listings ingested in 24 h, 29,723 open; pinnacle-listings-indexer 72/72 ok, a direct Flow REST events scan filtered to A.edf9df96c92f4595.Pinnacle.NFT.'::text)),
         '{marketplace,last_verified_at}', to_jsonb('2026-10-19T00:25:00Z'::text))
 where collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714';

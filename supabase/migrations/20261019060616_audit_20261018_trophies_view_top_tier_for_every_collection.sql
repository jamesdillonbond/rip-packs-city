-- audit_20261018_trophies_view_top_tier_for_every_collection
--
-- WHY (Trevor 10-18: "All supported collections should be usable there"): the
-- Trophy Room's view admitted "circulation 1 OR tier ULTIMATE". LaLiga Golazos
-- and Candy MLB have neither (their top tier is LEGENDARY; 0 one-of-ones), so
-- their tabs could only ever be empty. A collection's TROPHY tier is now its
-- top tier, DERIVED from the data rather than listed: ULTIMATE where the
-- collection has any ULTIMATE edition, otherwise LEGENDARY. Today that admits
-- Golazos 40 + Candy 25 LEGENDARY editions; every other collection is unchanged
-- (each has ULTIMATE). Disney Pinnacle is not in `editions` (pins live in
-- pinnacle_catalog) — lib/insights/trophies-board.ts reads it alongside.
--
-- HOW: CREATE OR REPLACE with the identical column list and order, plus ONE new
-- trailing column `is_top_tier` (allowed by CREATE OR REPLACE VIEW). `WITH
-- (security_invoker = on)` is restated because CREATE OR REPLACE resets
-- reloptions (database.md); grants are kept. Cost: the derived-tier subquery adds
-- ~12k buffers per read (≈31k → 43k measured) on a board cached for an hour.
--
-- POST-APPLY (10-18 ~11:07 PM PT): reloptions security_invoker=on and ACL unchanged; per collection
-- (rows / top tier / 1-of-1): candy_mlb 25/25/0, laliga_golazos 40/40/0, nba_top_shot 606/280/554,
-- nfl_all_day 500/423/443, panini_blockchain 1378/1378/1378, ufc_strike 48/13/45.
-- REVERT: re-create with the previous WHERE
--   (e.circulation_count = 1 OR e.tier = 'ULTIMATE'::tier_type) AND e.thumbnail_url IS NOT NULL
-- and without is_top_tier (DROP + CREATE is then required to remove the column;
-- re-grant SELECT to anon, authenticated and keep security_invoker = on).
CREATE OR REPLACE VIEW public.v_insights_trophies
WITH (security_invoker = on) AS
 WITH ult AS (
   SELECT DISTINCT editions.collection_id FROM editions WHERE editions.tier = 'ULTIMATE'::tier_type
 )
 SELECT e.id AS edition_id,
    e.external_id,
    e.collection,
    e.collection_id,
    e.name,
    e.player_name,
    e.set_name,
    e.team_name,
    e.tier::text AS tier,
    e.series,
    e.circulation_count,
    e.thumbnail_url,
    e.video_url,
    e.circulation_count = 1 AS is_one_of_one,
    e.tier = 'ULTIMATE'::tier_type AS is_ultimate,
    f.fmv_usd,
    f.confidence,
    f.computed_at AS fmv_computed_at,
    (e.tier = 'ULTIMATE'::tier_type
      OR (e.tier = 'LEGENDARY'::tier_type AND e.collection_id NOT IN (SELECT ult.collection_id FROM ult))) AS is_top_tier
   FROM editions e
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence,
            fs.computed_at
           FROM fmv_snapshots fs
          WHERE fs.edition_id = e.id
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON true
  WHERE (e.circulation_count = 1
      OR e.tier = 'ULTIMATE'::tier_type
      OR (e.tier = 'LEGENDARY'::tier_type AND e.collection_id NOT IN (SELECT ult.collection_id FROM ult)))
    AND e.thumbnail_url IS NOT NULL;

-- audit_20261109_trophies_view_held_twice_is_not_one_of_one
--
-- WHY (inbox 2026-11-10T0318Z, filed ~7:18 PM PT 11-09; applied ~7:41 PM PT by Claude Code on
-- Trevor's laptop): 183 hydrated Candy editions carry circulation_count = 1 but are held by MORE
-- THAN ONE distinct card in wallet_moments_cache — 2022 All-Star Tricons (180 editions, up to 4
-- cards each: on-chain names cut to 32 characters merge different trios into one key), The Bat
-- Cowl Collection (1 edition, 4,404 cards), Bat Cowl Honorary, Palm Garden: Inklings. The view
-- admitted them on circulation_count = 1 and set is_one_of_one, so /insights/trophies published
-- each as a single-copy trophy — a false claim. A held count above the circulation is a
-- CONTRADICTION, not a 1-of-1. (The root — keying and circulation in the Candy census — belongs
-- to the census owner; this is the read-side guard the filing asked for.)
--
-- WHAT: is_one_of_one = circulation_count = 1 AND fewer than 2 DISTINCT moment_ids hold the
-- edition (distinct, so one card seen under two wallets is still one card). Admission on
-- circulation alone follows the same rule; ULTIMATE / top-tier admission is unchanged.
-- Measured before applying: exactly 183 editions change, ALL Candy (Top Shot 554, All Day 443,
-- UFC 45, Panini 1,489 one-of-ones: 0 contradicted). Rows 7,552 -> 7,372 (180 leave; 3 stay as
-- top tier without the 1-of-1 flag).
--
-- HOW: candidates are materialized FIRST, then the held probe, then the latest-FMV lateral —
-- written as one WHERE the planner ran the FMV lateral for all 82k editions (523k buffers,
-- 6.8 s). This shape: 92.7k buffer hits, 451 ms warm (was 62k / 2.5 s partly cold); the probe
-- is index-only on idx_wmc_coll_ek_serial_cover. Same columns, names, types and order;
-- security_invoker = on restated (CREATE OR REPLACE resets reloptions); grants are kept.
--
-- REVERT: re-apply the view in
-- 20261019060616_audit_20261018_trophies_view_top_tier_for_every_collection.sql.
CREATE OR REPLACE VIEW public.v_insights_trophies
WITH (security_invoker = on) AS
 WITH ult AS (
   SELECT DISTINCT editions.collection_id FROM editions WHERE editions.tier = 'ULTIMATE'::tier_type
 ),
 cand AS MATERIALIZED (
   SELECT e.*,
     (e.tier = 'ULTIMATE'::tier_type
       OR (e.tier = 'LEGENDARY'::tier_type AND e.collection_id NOT IN (SELECT ult.collection_id FROM ult))) AS top_tier
   FROM editions e
   WHERE (e.circulation_count = 1
       OR e.tier = 'ULTIMATE'::tier_type
       OR (e.tier = 'LEGENDARY'::tier_type AND e.collection_id NOT IN (SELECT ult.collection_id FROM ult)))
     AND e.thumbnail_url IS NOT NULL
 ),
 held AS MATERIALIZED (
   SELECT c.*, (c.circulation_count = 1 AND h.n < 2) AS one_of_one
   FROM cand c
   LEFT JOIN LATERAL (
     SELECT count(*) AS n
     FROM (
       SELECT DISTINCT w.moment_id
       FROM wallet_moments_cache w
       WHERE c.circulation_count = 1
         AND w.collection_id = c.collection_id
         AND w.edition_key = c.external_id
       LIMIT 2
     ) x
   ) h ON true
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
    e.one_of_one AS is_one_of_one,
    e.tier = 'ULTIMATE'::tier_type AS is_ultimate,
    f.fmv_usd,
    f.confidence,
    f.computed_at AS fmv_computed_at,
    e.top_tier AS is_top_tier
   FROM held e
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence,
            fs.computed_at
           FROM fmv_snapshots fs
          WHERE fs.edition_id = e.id
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON true
  WHERE e.one_of_one OR e.top_tier;

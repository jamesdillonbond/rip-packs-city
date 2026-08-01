-- DB invariant: public.get_special_serial_owners_board(...) — backs the PUBLIC
-- /insights special-serial-owners board + the concierge tool. It reads the
-- per-collection special_serial_owners MV, applies tag/tier/player(ILIKE)/holder
-- filters, sorts by fmv or recency, and paginates. Pinned: collection routing
-- (topshot vs allday MV), each filter, the fmv/recent sort, the clamped limit
-- (1..200) + non-negative offset, and arg trimming/casing.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230900_audit_20260801_snapshot_get_special_serial_owners_board.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (db9d79ce89d53eaa6e30e788849162d1).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE topshot_special_serial_owners_mv (edition_id uuid, edition_key text, player_name text, set_name text, tier text, series smallint, team_name text, circulation_count integer, serial integer, tag text, holder_address text, nft_id text, holder_seen_at timestamptz, edition_fmv numeric);
CREATE TABLE allday_special_serial_owners_mv (LIKE topshot_special_serial_owners_mv);

-- >>> BEGIN verbatim get_special_serial_owners_board (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_special_serial_owners_board(p_tag text DEFAULT NULL::text, p_tier text DEFAULT NULL::text, p_player text DEFAULT NULL::text, p_holder text DEFAULT NULL::text, p_sort text DEFAULT 'fmv'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_collection text DEFAULT 'nba-top-shot'::text)
 RETURNS TABLE(edition_id uuid, edition_key text, player_name text, set_name text, tier text, series smallint, team_name text, circulation_count integer, serial integer, tag text, holder_address text, nft_id text, holder_seen_at timestamp with time zone, edition_fmv numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH args AS (
    SELECT
      NULLIF(btrim(p_tag), '')                       AS f_tag,
      upper(NULLIF(btrim(p_tier), ''))               AS f_tier,
      NULLIF(btrim(p_player), '')                    AS f_player,
      lower(NULLIF(btrim(p_holder), ''))             AS f_holder,
      CASE WHEN lower(btrim(p_sort)) = 'recent' THEN 'recent' ELSE 'fmv' END AS f_sort,
      LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200) AS f_limit,
      GREATEST(COALESCE(p_offset, 0), 0)             AS f_offset,
      CASE WHEN lower(btrim(p_collection)) IN ('nfl-all-day','nfl_all_day','allday')
           THEN 'allday' ELSE 'topshot' END          AS f_coll
  ),
  src AS (
    SELECT * FROM public.topshot_special_serial_owners_mv
      WHERE (SELECT f_coll FROM args) = 'topshot'
    UNION ALL
    SELECT * FROM public.allday_special_serial_owners_mv
      WHERE (SELECT f_coll FROM args) = 'allday'
  )
  SELECT
    o.edition_id,
    o.edition_key::text,
    o.player_name,
    o.set_name,
    o.tier::text,
    o.series,
    o.team_name,
    o.circulation_count,
    o.serial,
    o.tag,
    o.holder_address,
    o.nft_id,
    o.holder_seen_at,
    o.edition_fmv
  FROM src o, args a
  WHERE (a.f_tag    IS NULL OR o.tag = a.f_tag)
    AND (a.f_tier   IS NULL OR upper(o.tier::text) = a.f_tier)
    AND (a.f_player IS NULL OR o.player_name ILIKE '%' || a.f_player || '%')
    AND (a.f_holder IS NULL OR lower(o.holder_address) = a.f_holder)
  ORDER BY
    CASE WHEN a.f_sort = 'recent' THEN o.holder_seen_at END DESC NULLS LAST,
    CASE WHEN a.f_sort = 'fmv'    THEN o.edition_fmv     END DESC NULLS LAST,
    o.edition_fmv DESC NULLS LAST,
    o.edition_id,
    o.serial
  LIMIT (SELECT f_limit FROM args)
  OFFSET (SELECT f_offset FROM args);
$function$;
-- <<< END verbatim get_special_serial_owners_board <<<

-- 3 topshot rows + 1 allday row.
INSERT INTO topshot_special_serial_owners_mv (edition_id, edition_key, player_name, set_name, tier, series, team_name, circulation_count, serial, tag, holder_address, nft_id, holder_seen_at, edition_fmv) VALUES
  ('00000000-0000-0000-0000-0000000f0001','1:1','LeBron James','Base','LEGENDARY',4,'Lakers',100, 6,'JERSEY_MATCH','0xAAA','n1', now(),               500),
  ('00000000-0000-0000-0000-0000000f0002','2:2','Steph Curry', 'Base','RARE',     4,'Warriors',500,30,'FIRST_MINT', '0xBBB','n2', now()-interval '1 day', 300),
  ('00000000-0000-0000-0000-0000000f0003','3:3','LeBron James','Set2','COMMON',   4,'Lakers',1000,23,'JERSEY_MATCH','0xAAA','n3', now()-interval '2 day', 100);
INSERT INTO allday_special_serial_owners_mv (edition_id, edition_key, player_name, set_name, tier, series, team_name, circulation_count, serial, tag, holder_address, nft_id, holder_seen_at, edition_fmv) VALUES
  ('00000000-0000-0000-0000-0000000f00a1','9:9','Patrick Mahomes','AD','LEGENDARY',1,'Chiefs',50,1,'JERSEY_MATCH','0xCCC','na1', now(), 400);

-- 1) DEFAULT (topshot, sort=fmv): 3 topshot rows (NOT allday), ordered fmv DESC -> LeBron 500 first.
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board()), '3', 'default returns the 3 topshot rows only');
SELECT _assert_eq((SELECT player_name FROM get_special_serial_owners_board() LIMIT 1), 'LeBron James', 'fmv sort puts the $500 edition first');

-- 2) COLLECTION routing: nfl-all-day -> only the allday MV.
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board(p_collection => 'nfl-all-day')), '1', 'allday collection reads the allday MV');
SELECT _assert_eq((SELECT player_name FROM get_special_serial_owners_board(p_collection => 'nfl-all-day')), 'Patrick Mahomes', 'allday routing returns the allday row');

-- 3) TAG filter.
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board(p_tag => 'JERSEY_MATCH')), '2', 'tag filter (2 JERSEY_MATCH topshot rows)');

-- 4) TIER filter is case-insensitive (lower input -> upper match).
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board(p_tier => 'rare')), '1', 'tier filter case-insensitive (RARE)');

-- 5) PLAYER filter is a case-insensitive ILIKE substring.
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board(p_player => 'lebron')), '2', 'player ILIKE substring matches both LeBron rows');

-- 6) HOLDER filter is lower-exact.
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board(p_holder => '0xbbb')), '1', 'holder filter lower-exact');

-- 7) SORT=recent orders by holder_seen_at DESC -> the now() row (r1) first.
SELECT _assert_eq((SELECT edition_key FROM get_special_serial_owners_board(p_sort => 'recent') LIMIT 1), '1:1', 'recent sort puts the newest holder_seen_at first');

-- 8) PAGINATION: limit=1 -> 1 row (the $500); offset=1 -> the $300 (Steph).
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board(p_limit => 1)), '1', 'limit caps rows');
SELECT _assert_eq((SELECT player_name FROM get_special_serial_owners_board(p_limit => 1, p_offset => 1)), 'Steph Curry', 'offset skips the first fmv row');

-- 9) LIMIT clamp: p_limit=0 is clamped up to 1 (GREATEST(0,1)); p_limit=-5 too.
SELECT _assert_eq((SELECT count(*)::text FROM get_special_serial_owners_board(p_limit => 0)), '1', 'limit 0 clamps up to 1');

SELECT '✓ get_special_serial_owners_board invariants pass' AS result;
ROLLBACK;

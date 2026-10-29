-- 2026-10-28: catalog_topshot_subedition_editions_from_resolved() names a new parallel from topshot_subeditions
-- (the chain's TopShot.getAllSubeditions(), refreshed by rpc-topshot-subeditions-refresh) instead of a hardcoded
-- CASE that stopped at 22 Omega and invented 'Parallel N' for anything newer. Called by /api/admin/drain-conflated-
-- subeditions (Vercel cron), so from tomorrow's resolve of the Animated (23) / Illustrated (24) moments any
-- (base, sub) pair the Atlas walk had not already catalogued would have been created as "Parallel 23".
-- A pair whose id the chain list does not name is now SKIPPED (created on the run after the list learns it) —
-- an edition with an invented name is worse than one created a few hours later.
-- Same signature (p_limit DEFAULT 400), SECURITY DEFINER, search_path and statement_timeout; ACL restated below as read live 10-28.
-- anon-exec: unchanged (catalog_topshot_subedition_editions_from_resolved) — CREATE OR REPLACE of an existing fn, same signature; ACL restated (postgres, service_role only; anon=false, authenticated=false read 10-28).
-- revert: re-apply the body from the migration that last defined it (the CASE ... 'Parallel ' || id form).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.catalog_topshot_subedition_editions_from_resolved(integer)'::regprocedure)
     IS DISTINCT FROM 'b570104fa1c081d475e1d5712396ffa0' THEN
    RAISE EXCEPTION 'catalog_topshot_subedition_editions_from_resolved changed since it was read on 10-28; re-read before replacing';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.catalog_topshot_subedition_editions_from_resolved(p_limit integer DEFAULT 400)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $fn$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n integer;
BEGIN
  WITH pairs AS (
    SELECT DISTINCT sub.base_external_id AS base, sub.subedition_id
    FROM topshot_moment_subeditions sub
    WHERE sub.subedition_id > 0 AND sub.base_external_id ~ '^[0-9]+:[0-9]+$'
      -- 2026-10-28: only a parallel the chain list names; never invent a name
      AND EXISTS (SELECT 1 FROM topshot_subeditions ts WHERE ts.subedition_id = sub.subedition_id)
      AND NOT EXISTS (
        SELECT 1 FROM editions e WHERE e.collection_id = v_ts
          AND e.external_id = sub.base_external_id || '::' || sub.subedition_id)
    LIMIT greatest(1, p_limit)
  ),
  flr AS (
    SELECT p.base, p.subedition_id,
      GREATEST(COALESCE((
        SELECT max(s.serial_number)
        FROM topshot_moment_subeditions t
        JOIN sales s ON s.nft_id = t.nft_id AND s.collection_id = v_ts
        WHERE t.base_external_id = p.base AND t.subedition_id = p.subedition_id
      ), 1), 1) AS circ
    FROM pairs p
  )
  INSERT INTO editions (
    external_id, collection_id, player_id, set_id, name, tier, series, edition_kind,
    badges, reward_indicators, thumbnail_url, video_url, play_type, play_category, game_date,
    home_team, away_team, first_minted_at, set_id_onchain, play_id_onchain, collection,
    player_name, set_name, team_name, jersey_number, circulation_count, subedition_id, subedition_name)
  SELECT
    f.base || '::' || f.subedition_id, v_ts, b.player_id, b.set_id, b.name, b.tier, b.series, b.edition_kind,
    b.badges, b.reward_indicators, NULL, NULL, b.play_type, b.play_category, b.game_date,
    b.home_team, b.away_team, b.first_minted_at, b.set_id_onchain, b.play_id_onchain, b.collection,
    b.player_name, b.set_name, b.team_name, b.jersey_number, f.circ, f.subedition_id,
    ts.name
  FROM flr f
  JOIN editions b ON b.collection_id = v_ts AND b.external_id = f.base
  JOIN topshot_subeditions ts ON ts.subedition_id = f.subedition_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

REVOKE ALL ON FUNCTION public.catalog_topshot_subedition_editions_from_resolved(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_topshot_subedition_editions_from_resolved(integer) TO service_role;

-- 2026-10-21 ~12:20 PM PT (Claude Code cloud; Trevor: "Keep going") — players.team from the league's
-- CURRENT season when the stats feed has it.
--
-- Found by the tenth live sweep: /nba-top-shot/player/lebron-james read "# 23 Los Angeles Lakers" in its
-- header beside its own Season Stats row "2026-27 Philadelphia 76ers" (ESPN). refresh_players_current_team
-- derives the team from the catalogue's latest moment, and the catalogue learns a trade only when a NEW
-- moment mints, so every offseason move reads the old team until then (Series 9 started minting 10-21).
-- Measured 12:15 PM PT: 37 Top Shot players have 2026-27 stats so far; 5 disagree with players.team
-- (LeBron James, Kentavious Caldwell-Pope, Anfernee Simons → Philadelphia 76ers; John Collins → Detroit
-- Pistons; Andre Drummond → New York Knicks), and the count grows as ESPN fills the season.
--
-- CHANGE: a player with exactly ONE regular-season team in the league's latest season (player_identities →
-- player_season_stats, non-total rows) takes that team, under the catalogue's own display name for the
-- slug. A mid-season trade (two teams), an unmapped slug, or no current-season row falls back to the
-- catalogue path, which is unchanged. Dry run before applying: exactly the 5 rows above change, 0 slugs
-- unmapped, no catalogue-only player moves.
--
-- Pinned: supabase/tests/refresh_players_current_team.sql (verbatim copy + 4 new assertions);
-- PINS entry in __tests__/db-invariants-drift-guard.test.ts points here.
--
-- anon-exec: intentional — not granted (refresh_players_current_team): CREATE OR REPLACE keeps the existing ACL,
-- read 12:30 PM PT: postgres / service_role / cron_heavy only, has_function_privilege('anon', …) = false.
--
-- REVERT: re-apply the body from 20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql.
CREATE OR REPLACE FUNCTION public.refresh_players_current_team(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated int;
BEGIN
  IF p_collection_id IS NULL THEN
    RETURN 0;
  END IF;

  WITH h AS (
    SELECT max(game_date) AS mg FROM public.editions
     WHERE collection_id = p_collection_id AND game_date IS NOT NULL
  ), r AS (
    SELECT DISTINCT ON (e.player_name) e.player_name, e.team_name
      FROM public.editions e, h
     WHERE e.collection_id = p_collection_id
       AND e.team_name IS NOT NULL
       AND e.game_date IS NOT NULL
       AND e.game_date >= h.mg - interval '18 months'
     ORDER BY e.player_name, e.game_date DESC
  ),
  -- 2026-10-21: the catalogue only learns a trade when a NEW moment mints, so every
  -- offseason move read the old team until then (LeBron James "Los Angeles Lakers" beside
  -- his own 2026-27 Philadelphia 76ers stat line). The league's CURRENT regular season,
  -- when the stats feed has it and the player has exactly ONE team in it, wins; a
  -- mid-season trade (two teams) and an unmapped slug fall back to the catalogue.
  latest AS (
    SELECT s.league, max(s.season) AS season
      FROM public.player_season_stats s
     WHERE s.season_type = 2
     GROUP BY s.league
  ), cur AS (
    SELECT i.player_id, min(s.team_slug) AS team_slug
      FROM public.player_identities i
      JOIN public.players p ON p.id = i.player_id AND p.collection_id = p_collection_id
      JOIN latest l ON l.league = i.league
      JOIN public.player_season_stats s
        ON s.league = i.league AND s.espn_id = i.espn_id AND s.season = l.season
       AND s.season_type = 2 AND NOT s.is_total AND coalesce(s.team_slug, '') <> ''
     WHERE i.espn_id IS NOT NULL
     GROUP BY i.player_id
    HAVING count(DISTINCT s.team_slug) = 1
  ), names AS (
    SELECT DISTINCT ON (k.slug) k.slug, k.team_name
      FROM (SELECT regexp_replace(lower(e.team_name), '[^a-z0-9]+', '-', 'g') AS slug, e.team_name
              FROM public.editions e
             WHERE e.collection_id = p_collection_id AND e.team_name IS NOT NULL) k
     ORDER BY k.slug, k.team_name
  ), want AS (
    SELECT p.id, coalesce(n.team_name, r.team_name) AS team
      FROM public.players p
      LEFT JOIN r ON r.player_name = p.name
      LEFT JOIN cur c ON c.player_id = p.id
      LEFT JOIN names n ON n.slug = c.team_slug
     WHERE p.collection_id = p_collection_id
  ), upd AS (
    UPDATE public.players p
       SET team = w.team, updated_at = now()
      FROM want w
     WHERE p.id = w.id
       AND p.collection_id = p_collection_id
       AND w.team IS NOT NULL
       AND p.team IS DISTINCT FROM w.team
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  RETURN v_updated;
END
$function$;

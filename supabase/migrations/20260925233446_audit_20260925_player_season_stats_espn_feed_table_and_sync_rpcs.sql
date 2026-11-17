-- 2026-09-25 (PT) — player_season_stats: the live-stats feed's table, fed from
-- ESPN's public JSON through the league-id crosswalk (batch 47; the third
-- part of the #139 long-term plan Trevor approved: "Proceed with the all").
--
-- WHY. RPC has no player stats at all; sync-nba-projections (#8, shelved) is
-- the only stats lane and every upstream 403s from Supabase edge. The research
-- (Project doc research-2026-09-25-player-identity-and-stats-feed.md) measured
-- ESPN's public JSON — site.web.api.espn.com/apis/common/v3/sports/<sport>/
-- <league>/athletes/<espn_id>/stats — answering 200 from the cloud sandbox and
-- the laptop VM for BOTH leagues, keyed by an ESPN athlete id that nflverse
-- already supplies for the NFL (espn_id on 16,565 of 24,830 rows) and that an
-- ESPN name search supplies for the NBA. So: a GitHub Actions runner fetches
-- ESPN (the Atlas pattern — a runner that reaches the source, a Bearer route
-- that owns the DB), and every row here joins back to a players row through
-- player_identities.
--
-- WHAT.
-- (1) public.player_season_stats — one row per (league, espn_id, season,
--     season_type, category): ESPN's labels / names / values arrays kept AS
--     GIVEN (values are display strings — '5,097', '9.3-18.1'); team_slug;
--     refreshed_at. RLS on, service_role only (the player page reads through a
--     SECURITY DEFINER RPC).
-- (2) player_identities.stats_refreshed_at + espn_id_matched_by — the runner's
--     cursor (stalest first) and the provenance of a search-resolved ESPN id.
-- (3) player_stats_sync_targets(p_league, p_limit) — linked identities with an
--     espn_id, stalest first. player_stats_espn_resolve_targets(p_league,
--     p_limit) — linked identities WITHOUT one (the NBA half today).
-- (4) set_player_identity_espn_ids(p_league, p_rows) — writes a search-resolved
--     espn_id ONLY where NULL (never overwrites nflverse's), with its provenance.
-- (5) upsert_player_season_stats(p_league, p_rows, p_touched) — the chunk
--     write; stamps stats_refreshed_at on the touched identities so a player
--     ESPN answered with ZERO categories (a rookie, a retired man) still leaves
--     the front of the queue. Returns rows written.
-- (6) get_player_season_stats(p_player_id, p_seasons) — the read: the player's
--     categories for the latest N seasons, newest first, plus when it was
--     refreshed; NULL (not []) when the player has no identity or no espn_id,
--     so the page can tell "no feed" from "no stats".
--
-- Revert: DROP FUNCTION public.get_player_season_stats(uuid, int);
--   DROP FUNCTION public.upsert_player_season_stats(text, jsonb, text[]);
--   DROP FUNCTION public.set_player_identity_espn_ids(text, jsonb);
--   DROP FUNCTION public.player_stats_espn_resolve_targets(text, int);
--   DROP FUNCTION public.player_stats_sync_targets(text, int);
--   ALTER TABLE public.player_identities DROP COLUMN stats_refreshed_at, DROP COLUMN espn_id_matched_by;
--   DROP TABLE public.player_season_stats;

-- (1)
CREATE TABLE IF NOT EXISTS public.player_season_stats (
  league       text NOT NULL CHECK (league IN ('nba', 'nfl')),
  espn_id      text NOT NULL CHECK (espn_id <> ''),
  season       int  NOT NULL,
  season_type  int  NOT NULL DEFAULT 2,
  category     text NOT NULL CHECK (category <> ''),
  display_name text,
  team_slug    text,
  labels       text[] NOT NULL,
  names        text[] NOT NULL,
  "values"     text[] NOT NULL,
  source       text NOT NULL DEFAULT 'espn',
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league, espn_id, season, season_type, category),
  CHECK (array_length(labels, 1) = array_length("values", 1))
);
COMMENT ON TABLE public.player_season_stats IS
  'Per-player per-season stat lines from ESPN''s public JSON (athletes/<espn_id>/stats), kept as ESPN gives them: labels (GP, YDS…), names (gamesPlayed…), values (display strings). Joins to players through player_identities.espn_id. Written by upsert_player_season_stats (the player-stats-sync route, GitHub Actions runner); read by get_player_season_stats. Added 2026-09-25 (batch 47).';
ALTER TABLE public.player_season_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_season_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.player_season_stats TO service_role;

-- (2)
ALTER TABLE public.player_identities
  ADD COLUMN IF NOT EXISTS stats_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS espn_id_matched_by text;
CREATE INDEX IF NOT EXISTS player_identities_stats_cursor_idx
  ON public.player_identities (league, stats_refreshed_at NULLS FIRST)
  WHERE player_id IS NOT NULL AND espn_id IS NOT NULL;

-- (3)
CREATE OR REPLACE FUNCTION public.player_stats_sync_targets(p_league text, p_limit integer DEFAULT 300)
 RETURNS TABLE(identity_id uuid, espn_id text, display_name text, stats_refreshed_at timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT i.id, i.espn_id, i.display_name, i.stats_refreshed_at
    FROM public.player_identities i
   WHERE i.league = p_league
     AND i.player_id IS NOT NULL
     AND i.espn_id IS NOT NULL
   ORDER BY i.stats_refreshed_at NULLS FIRST, i.refreshed_at, i.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 300), 2000))
$function$;
REVOKE ALL ON FUNCTION public.player_stats_sync_targets(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_stats_sync_targets(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.player_stats_espn_resolve_targets(p_league text, p_limit integer DEFAULT 200)
 RETURNS TABLE(identity_id uuid, display_name text, name_slug text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT i.id, i.display_name, i.name_slug
    FROM public.player_identities i
   WHERE i.league = p_league
     AND i.player_id IS NOT NULL
     AND i.espn_id IS NULL
     -- a name the search already failed to settle is not retried every run
     AND (i.espn_id_matched_by IS NULL OR i.espn_id_matched_by NOT LIKE 'unresolved:%')
   ORDER BY (SELECT count(*) FROM public.editions e WHERE e.player_id = i.player_id) DESC, i.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 2000))
$function$;
REVOKE ALL ON FUNCTION public.player_stats_espn_resolve_targets(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_stats_espn_resolve_targets(text, integer) TO service_role;

-- (4)
CREATE OR REPLACE FUNCTION public.set_player_identity_espn_ids(p_league text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  WITH r AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
             AS x(identity_id uuid, espn_id text, matched_by text)
  ),
  upd AS (
    UPDATE public.player_identities i
       SET espn_id = CASE WHEN r.espn_id IS NOT NULL AND trim(r.espn_id) <> '' THEN trim(r.espn_id) ELSE i.espn_id END,
           espn_id_matched_by = COALESCE(nullif(trim(r.matched_by), ''), i.espn_id_matched_by)
      FROM r
     WHERE i.id = r.identity_id AND i.league = p_league
       AND i.espn_id IS NULL
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM upd;
  RETURN v_n;
END
$function$;
REVOKE ALL ON FUNCTION public.set_player_identity_espn_ids(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_player_identity_espn_ids(text, jsonb) TO service_role;

-- (5)
CREATE OR REPLACE FUNCTION public.upsert_player_season_stats(p_league text, p_rows jsonb, p_touched text[] DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  IF p_league NOT IN ('nba', 'nfl') THEN
    RAISE EXCEPTION 'upsert_player_season_stats: unknown league %', p_league;
  END IF;
  WITH r AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
             AS x(espn_id text, season int, season_type int, category text, display_name text,
                  team_slug text, labels text[], names text[], "values" text[])
  ),
  ins AS (
    INSERT INTO public.player_season_stats
      (league, espn_id, season, season_type, category, display_name, team_slug, labels, names, "values", source, refreshed_at)
    SELECT p_league, trim(r.espn_id), r.season, COALESCE(r.season_type, 2), trim(r.category),
           nullif(trim(r.display_name), ''), nullif(trim(r.team_slug), ''),
           r.labels, r.names, r."values", 'espn', now()
      FROM r
     WHERE r.espn_id IS NOT NULL AND trim(r.espn_id) <> ''
       AND r.season IS NOT NULL AND r.category IS NOT NULL AND trim(r.category) <> ''
       AND r.labels IS NOT NULL AND r.names IS NOT NULL AND r."values" IS NOT NULL
       AND array_length(r.labels, 1) = array_length(r."values", 1)
    ON CONFLICT (league, espn_id, season, season_type, category) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      team_slug    = EXCLUDED.team_slug,
      labels       = EXCLUDED.labels,
      names        = EXCLUDED.names,
      "values"     = EXCLUDED."values",
      source       = EXCLUDED.source,
      refreshed_at = now()
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM ins;

  IF p_touched IS NOT NULL AND array_length(p_touched, 1) > 0 THEN
    UPDATE public.player_identities i
       SET stats_refreshed_at = now()
     WHERE i.league = p_league AND i.espn_id = ANY (p_touched);
  END IF;
  RETURN v_n;
END
$function$;
REVOKE ALL ON FUNCTION public.upsert_player_season_stats(text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_player_season_stats(text, jsonb, text[]) TO service_role;

-- (6)
CREATE OR REPLACE FUNCTION public.get_player_season_stats(p_player_id uuid, p_seasons integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ident record;
  v_rows  jsonb;
  v_refreshed timestamptz;
BEGIN
  SELECT i.id, i.league, i.espn_id, i.display_name, i.stats_refreshed_at
    INTO v_ident
    FROM public.player_identities i
   WHERE i.player_id = p_player_id
   LIMIT 1;
  -- no identity, or an identity the feed cannot key: the page must say "no
  -- feed for this player", never "no stats"
  IF v_ident.id IS NULL OR v_ident.espn_id IS NULL THEN
    RETURN NULL;
  END IF;

  WITH seasons AS (
    SELECT DISTINCT s.season
      FROM public.player_season_stats s
     WHERE s.league = v_ident.league AND s.espn_id = v_ident.espn_id AND s.season_type = 2
     ORDER BY s.season DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_seasons, 3), 20))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'season', s.season,
           'season_type', s.season_type,
           'category', s.category,
           'display_name', s.display_name,
           'team_slug', s.team_slug,
           'labels', to_jsonb(s.labels),
           'names', to_jsonb(s.names),
           'values', to_jsonb(s."values")
         ) ORDER BY s.season DESC, s.category), '[]'::jsonb),
         max(s.refreshed_at)
    INTO v_rows, v_refreshed
    FROM public.player_season_stats s
    JOIN seasons z ON z.season = s.season
   WHERE s.league = v_ident.league AND s.espn_id = v_ident.espn_id AND s.season_type = 2;

  RETURN jsonb_build_object(
    'league', v_ident.league,
    'espn_id', v_ident.espn_id,
    'display_name', v_ident.display_name,
    'stats_refreshed_at', v_ident.stats_refreshed_at,
    'rows_refreshed_at', v_refreshed,
    'rows', v_rows
  );
END
$function$;
REVOKE ALL ON FUNCTION public.get_player_season_stats(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_season_stats(uuid, integer) TO service_role;

-- Post-conditions
DO $$
DECLARE v_n int; r jsonb;
BEGIN
  IF has_table_privilege('anon', 'public.player_season_stats', 'SELECT') THEN
    RAISE EXCEPTION 'player_season_stats: anon can read it';
  END IF;
  SELECT count(*) INTO v_n FROM public.player_stats_sync_targets('nfl', 5);
  IF v_n <> 5 THEN RAISE EXCEPTION 'player_stats_sync_targets(nfl, 5) returned % rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.player_stats_espn_resolve_targets('nba', 5);
  IF v_n <> 5 THEN RAISE EXCEPTION 'player_stats_espn_resolve_targets(nba, 5) returned % rows', v_n; END IF;
  -- a player with no identity reads NULL, not an empty list
  r := public.get_player_season_stats('00000000-0000-0000-0000-000000000000', 3);
  IF r IS NOT NULL THEN RAISE EXCEPTION 'get_player_season_stats: unknown player should be NULL, got %', r; END IF;
END $$;

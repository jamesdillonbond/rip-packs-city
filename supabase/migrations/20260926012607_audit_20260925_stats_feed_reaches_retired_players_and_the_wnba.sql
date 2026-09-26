-- 2026-09-25 (PT) — the stats feed reaches RETIRED players and the WNBA.
-- First clean runs left 64 Top Shot identities 'unresolved:none': ESPN's
-- /apis/common/v3/search returns ACTIVE players only (Paul Pierce, Kevin
-- Garnett, Carmelo Anthony, Kemba Walker, Blake Griffin… all empty), spells
-- "Steph Curry" as Stephen Curry (an alias RPC already holds), and lists the
-- WNBA players Top Shot mints — A'ja Wilson 41 editions, Chelsea Gray 42,
-- Caitlin Clark 33, ~45 in all — under league 'wnba', which the matcher
-- refused. ESPN's /apis/search/v2 (measured 2026-09-25 from the cloud)
-- returns retired players, carries the athlete id in `uid` (s:40~l:46~a:662)
-- and the league in `defaultLeagueSlug`; the stats endpoint serves both a
-- retired id (662 → 19 seasons) and a WNBA id under basketball/wnba
-- (3149391 → 9 seasons, calendar-year seasons).
--
-- Schema: player_identities.espn_league (nba | wnba | nfl) — which ESPN
-- league the id lives in; the identity's `league` stays the collection's
-- (Top Shot = nba). set_player_identity_espn_ids takes it; the sync targets
-- carry it; the resolve targets carry the player's ALIAS spellings so the
-- runner can retry ("stephen curry"); every 'unresolved:*' NBA identity is
-- re-queued once for the new search; get_player_season_stats returns it so
-- the page labels a WNBA season by its year (2026), not "2025-26".
--
-- Revert: ALTER TABLE player_identities DROP COLUMN espn_league; re-apply
-- the four functions from 20260925233446 / 20260925235606.

ALTER TABLE public.player_identities
  ADD COLUMN IF NOT EXISTS espn_league text CHECK (espn_league IN ('nba', 'wnba', 'nfl'));
COMMENT ON COLUMN public.player_identities.espn_league IS
  'Which ESPN league the espn_id lives in (nba | wnba | nfl). The identity''s league stays the collection''s (Top Shot = nba, so a WNBA player is league nba / espn_league wnba). NULL until an espn_id is set.';

UPDATE public.player_identities SET espn_league = 'nfl' WHERE league = 'nfl' AND espn_id IS NOT NULL AND espn_league IS NULL;
UPDATE public.player_identities SET espn_league = 'nba' WHERE league = 'nba' AND espn_id IS NOT NULL AND espn_league IS NULL;
-- re-queue every name the v3 search could not settle: the v2 search sees more
UPDATE public.player_identities SET espn_id_matched_by = NULL
 WHERE league = 'nba' AND espn_id IS NULL AND espn_id_matched_by LIKE 'unresolved:%';

-- anon-exec: intentional — full-body write of set_player_identity_espn_ids; its ACL
-- (service_role only, 20260925233446) is unchanged by CREATE OR REPLACE
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
             AS x(identity_id uuid, espn_id text, matched_by text, espn_league text)
  ),
  upd AS (
    UPDATE public.player_identities i
       SET espn_id = CASE WHEN r.espn_id IS NOT NULL AND trim(r.espn_id) <> '' THEN trim(r.espn_id) ELSE i.espn_id END,
           espn_id_matched_by = COALESCE(nullif(trim(r.matched_by), ''), i.espn_id_matched_by),
           -- 2026-09-25: the ESPN league the id lives in; a resolved id without
           -- one is the collection's league (Top Shot's WNBA players say 'wnba')
           espn_league = CASE WHEN r.espn_id IS NOT NULL AND trim(r.espn_id) <> ''
                              THEN COALESCE(nullif(lower(trim(r.espn_league)), ''), CASE p_league WHEN 'nfl' THEN 'nfl' ELSE 'nba' END)
                              ELSE i.espn_league END
      FROM r
     WHERE i.id = r.identity_id AND i.league = p_league
       AND i.espn_id IS NULL
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM upd;
  RETURN v_n;
END
$function$;

-- the return set gains a column, which CREATE OR REPLACE refuses: drop, recreate, re-grant
DROP FUNCTION IF EXISTS public.player_stats_sync_targets(text, integer);
-- anon-exec: intentional — player_stats_sync_targets is re-created service_role only (REVOKE/GRANT below)
CREATE OR REPLACE FUNCTION public.player_stats_sync_targets(p_league text, p_limit integer DEFAULT 300)
 RETURNS TABLE(identity_id uuid, espn_id text, espn_league text, display_name text, stats_refreshed_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT i.id AS identity_id, i.espn_id, COALESCE(i.espn_league, i.league) AS espn_league, i.display_name, i.stats_refreshed_at
    FROM public.player_identities i
   WHERE i.league = p_league
     AND i.player_id IS NOT NULL
     AND i.espn_id IS NOT NULL
   ORDER BY i.stats_refreshed_at NULLS FIRST, i.refreshed_at, i.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 300), 2000))
$function$;
REVOKE ALL ON FUNCTION public.player_stats_sync_targets(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_stats_sync_targets(text, integer) TO service_role;

DROP FUNCTION IF EXISTS public.player_stats_espn_resolve_targets(text, integer);
-- anon-exec: intentional — player_stats_espn_resolve_targets is re-created service_role only (REVOKE/GRANT below)
CREATE OR REPLACE FUNCTION public.player_stats_espn_resolve_targets(p_league text, p_limit integer DEFAULT 200)
 RETURNS TABLE(identity_id uuid, display_name text, name_slug text, aliases text[])
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT i.id AS identity_id, i.display_name, i.name_slug,
         -- every other spelling RPC knows for this person: the catalog row's
         -- own name when it differs, and the registered aliases
         (SELECT COALESCE(array_agg(DISTINCT s ORDER BY s), '{}'::text[])
            FROM (
              SELECT regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') AS s
                FROM public.players p WHERE p.id = i.player_id
              UNION
              SELECT a.alias_slug FROM public.player_name_aliases a WHERE a.player_id = i.player_id
            ) z
           WHERE z.s <> '' AND z.s <> i.name_slug) AS aliases
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

-- anon-exec: intentional — full-body write of get_player_season_stats; ACL unchanged (the player page reads it as service_role)
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
  SELECT i.id, i.league, i.espn_id, i.espn_league, i.display_name, i.stats_refreshed_at
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
           'team_slug', nullif(s.team_slug, ''),
           'is_total', s.is_total,
           'labels', to_jsonb(s.labels),
           'names', to_jsonb(s.names),
           'values', to_jsonb(s."values")
         ) ORDER BY s.season DESC, s.category, s.is_total DESC, s.team_slug), '[]'::jsonb),
         max(s.refreshed_at)
    INTO v_rows, v_refreshed
    FROM public.player_season_stats s
    JOIN seasons z ON z.season = s.season
   WHERE s.league = v_ident.league AND s.espn_id = v_ident.espn_id AND s.season_type = 2;

  RETURN jsonb_build_object(
    'league', v_ident.league,
    'espn_id', v_ident.espn_id,
    -- 2026-09-25: which ESPN league the lines come from (a WNBA season is a
    -- calendar year; the page labels it so)
    'espn_league', COALESCE(v_ident.espn_league, v_ident.league),
    'display_name', v_ident.display_name,
    'stats_refreshed_at', v_ident.stats_refreshed_at,
    'rows_refreshed_at', v_refreshed,
    'rows', v_rows
  );
END
$function$;

-- Post-conditions
DO $$
DECLARE v_n int; r jsonb; v_pid uuid; v_t text;
BEGIN
  SELECT count(*) INTO v_n FROM public.player_identities WHERE espn_id IS NOT NULL AND espn_league IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'espn_league backfill: % keyed identities without one', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.player_identities WHERE league = 'nba' AND espn_id IS NULL AND espn_id_matched_by LIKE 'unresolved:%';
  IF v_n <> 0 THEN RAISE EXCEPTION 're-queue: % still marked unresolved', v_n; END IF;
  -- Steph Curry's resolve target carries his alias spelling
  SELECT t.aliases::text INTO v_t FROM public.player_stats_espn_resolve_targets('nba', 2000) t
    JOIN public.player_identities i ON i.id = t.identity_id WHERE i.display_name = 'Steph Curry';
  IF v_t IS NULL OR v_t NOT LIKE '%stephen-curry%' THEN RAISE EXCEPTION 'resolve targets: Steph Curry aliases %', v_t; END IF;
  -- the reader carries espn_league for a keyed player (Jokić)
  SELECT i.player_id INTO v_pid FROM public.player_identities i WHERE i.league = 'nba' AND i.espn_id = '3112335';
  IF v_pid IS NOT NULL THEN
    r := public.get_player_season_stats(v_pid, 1);
    IF r->>'espn_league' <> 'nba' THEN RAISE EXCEPTION 'reader: espn_league %', r->>'espn_league'; END IF;
  END IF;
END $$;

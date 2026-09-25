-- 2026-09-25 (PT) — player_identities: the LEAGUE'S OWN id for every player,
-- so the platform stops keying people on a name (#139 follow-up; Trevor:
-- "Figure out what will work best for our long term plan" → "Proceed with the all").
--
-- WHY. Every player writer resolves on a name slug (resolve_canonical_player,
-- ensure_players_from_edition_names, the daily link_editions_to_players_by_name).
-- All Day labels drift between seasons ("Patrick Mahomes II" → "Patrick Mahomes"),
-- Top Shot's per-play fossil ids mint a row per spelling, and two people can
-- share a label ("Marvin Harrison" the Colts father and the Cardinals son sat
-- on ONE row until 20260925212218 split them by team). The 09-25 alias table
-- is a patch list, not an identity. The league sites settle every case, and
-- both leagues publish an id: NBA's person id (already players.external_id for
-- 1,317 of 1,362 Top Shot rows) and the NFL's GSIS id (open, weekly, with the
-- NFL.com spelling, birth date, team and ESPN/PFR ids, from nflverse
-- players.csv — 24,830 rows, measured 2026-09-25).
--
-- WHAT.
-- (1) public.player_identities — one row per league player id, with the
--     league's spelling, birth date, latest team, seasons and the other feeds'
--     ids (espn_id is what a live stats feed joins on). player_id links it to
--     RPC's row when one is known; NULL means "league knows this person, RPC
--     has no row (yet)". RLS on, service_role only.
-- (2) upsert_player_identities(p_league, p_source, p_rows jsonb) — the write
--     the sync route makes (app/api/cron/player-identities-sync). Refreshes the
--     league fields; never touches an existing player_id link.
-- (3) match_player_identities(p_league) — PINNED (supabase/tests). Links free
--     identities to free players: by the name slug when unique both ways; when
--     two league rows share a name, by the TEAM the player's editions carry
--     (Josh Allen the Bills QB vs the 2016 Buccaneers centre), then by season
--     overlap; anything still ambiguous is COUNTED and left NULL, never guessed.
-- (4) The NBA half seeded from players.external_id (the person id), source
--     'players.external_id'.
--
-- Revert: DROP FUNCTION public.match_player_identities(text);
--         DROP FUNCTION public.upsert_player_identities(text, text, jsonb);
--         DROP TABLE public.player_identities;

-- (1)
CREATE TABLE IF NOT EXISTS public.player_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league           text NOT NULL CHECK (league IN ('nba', 'nfl')),
  league_player_id text NOT NULL CHECK (league_player_id <> ''),
  collection_id    uuid NOT NULL REFERENCES public.collections(id),
  player_id        uuid REFERENCES public.players(id) ON DELETE SET NULL,
  matched_by       text,
  matched_at       timestamptz,
  name_slug        text NOT NULL,
  display_name     text NOT NULL CHECK (display_name <> ''),
  first_name       text,
  last_name        text,
  birth_date       date,
  position         text,
  latest_team      text,
  rookie_season    int,
  last_season      int,
  status           text,
  espn_id          text,
  pfr_id           text,
  nfl_id           text,
  headshot_url     text,
  source           text NOT NULL,
  refreshed_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league, league_player_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS player_identities_player_id_uidx
  ON public.player_identities (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_identities_league_slug_idx
  ON public.player_identities (league, name_slug);
COMMENT ON TABLE public.player_identities IS
  'The league''s own id per player: nba = NBA person id, nfl = NFL GSIS id. display_name is the league site''s spelling; name_slug = regexp_replace(lower(trim(unaccent(display_name))), ''[^a-z0-9]+'', ''-'', ''g''). player_id links the RPC players row when known (matched_by says how; NULL = league knows this person, RPC has no row). Written by upsert_player_identities (the player-identities-sync route, nflverse players.csv weekly) and match_player_identities. Added 2026-09-25 (#139 follow-up).';
ALTER TABLE public.player_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.player_identities TO service_role;

-- (2)
CREATE OR REPLACE FUNCTION public.upsert_player_identities(p_league text, p_source text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll uuid;
  v_n    int;
BEGIN
  IF p_league NOT IN ('nba', 'nfl') THEN
    RAISE EXCEPTION 'upsert_player_identities: unknown league %', p_league;
  END IF;
  IF p_source IS NULL OR trim(p_source) = '' THEN
    RAISE EXCEPTION 'upsert_player_identities: source is required';
  END IF;
  SELECT c.id INTO v_coll FROM public.collections c
   WHERE c.slug = CASE p_league WHEN 'nba' THEN 'nba_top_shot' ELSE 'nfl_all_day' END;
  IF v_coll IS NULL THEN
    RAISE EXCEPTION 'upsert_player_identities: no collection for league %', p_league;
  END IF;

  WITH ins AS (
    INSERT INTO public.player_identities
      (league, league_player_id, collection_id, name_slug, display_name, first_name, last_name,
       birth_date, position, latest_team, rookie_season, last_season, status,
       espn_id, pfr_id, nfl_id, headshot_url, source, refreshed_at)
    SELECT p_league,
           trim(r.league_player_id),
           v_coll,
           regexp_replace(lower(trim(extensions.unaccent(r.display_name))), '[^a-z0-9]+', '-', 'g'),
           trim(r.display_name),
           nullif(trim(r.first_name), ''), nullif(trim(r.last_name), ''),
           r.birth_date, nullif(trim(r.position), ''), nullif(trim(r.latest_team), ''),
           r.rookie_season, r.last_season, nullif(trim(r.status), ''),
           nullif(trim(r.espn_id), ''), nullif(trim(r.pfr_id), ''), nullif(trim(r.nfl_id), ''),
           nullif(trim(r.headshot_url), ''),
           p_source, now()
      FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(
             league_player_id text, display_name text, first_name text, last_name text,
             birth_date date, position text, latest_team text, rookie_season int, last_season int,
             status text, espn_id text, pfr_id text, nfl_id text, headshot_url text)
     WHERE r.league_player_id IS NOT NULL AND trim(r.league_player_id) <> ''
       AND r.display_name IS NOT NULL AND trim(r.display_name) <> ''
    ON CONFLICT (league, league_player_id) DO UPDATE SET
      name_slug     = EXCLUDED.name_slug,
      display_name  = EXCLUDED.display_name,
      first_name    = EXCLUDED.first_name,
      last_name     = EXCLUDED.last_name,
      birth_date    = COALESCE(EXCLUDED.birth_date, public.player_identities.birth_date),
      position      = COALESCE(EXCLUDED.position, public.player_identities.position),
      latest_team   = COALESCE(EXCLUDED.latest_team, public.player_identities.latest_team),
      rookie_season = COALESCE(EXCLUDED.rookie_season, public.player_identities.rookie_season),
      last_season   = COALESCE(EXCLUDED.last_season, public.player_identities.last_season),
      status        = COALESCE(EXCLUDED.status, public.player_identities.status),
      espn_id       = COALESCE(EXCLUDED.espn_id, public.player_identities.espn_id),
      pfr_id        = COALESCE(EXCLUDED.pfr_id, public.player_identities.pfr_id),
      nfl_id        = COALESCE(EXCLUDED.nfl_id, public.player_identities.nfl_id),
      headshot_url  = COALESCE(EXCLUDED.headshot_url, public.player_identities.headshot_url),
      source        = EXCLUDED.source,
      refreshed_at  = now()
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM ins;
  RETURN v_n;
END
$function$;
REVOKE ALL ON FUNCTION public.upsert_player_identities(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_player_identities(text, text, jsonb) TO service_role;

-- (3)
CREATE OR REPLACE FUNCTION public.match_player_identities(p_league text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll    uuid;
  v_by      jsonb;
  v_amb     int;
  v_players int;
  v_unm     int;
  v_ids     int;
  v_idsunl  int;
BEGIN
  IF p_league NOT IN ('nba', 'nfl') THEN
    RAISE EXCEPTION 'match_player_identities: unknown league %', p_league;
  END IF;
  SELECT c.id INTO v_coll FROM public.collections c
   WHERE c.slug = CASE p_league WHEN 'nba' THEN 'nba_top_shot' ELSE 'nfl_all_day' END;
  IF v_coll IS NULL THEN
    RAISE EXCEPTION 'match_player_identities: no collection for league %', p_league;
  END IF;

  WITH team_abbr AS (
    -- an edition's team_name -> the abbreviation the league row carries
    SELECT t.team_name, t.abbreviation AS abbr
      FROM public.teams_master t
     WHERE t.league::text = upper(p_league)
    UNION ALL
    SELECT v.team_name, v.abbr
      FROM (VALUES
        ('nfl', 'Washington Football Team', 'WAS'), ('nfl', 'Washington Redskins', 'WAS'),
        ('nfl', 'San Diego Chargers', 'LAC'),       ('nfl', 'St. Louis Rams', 'LAR'),
        ('nfl', 'Oakland Raiders', 'LV'),           ('nfl', 'Los Angeles Raiders', 'LV'),
        ('nfl', 'Houston Oilers', 'TEN'),           ('nfl', 'Tennessee Oilers', 'TEN'),
        ('nfl', 'Phoenix Cardinals', 'ARI'),        ('nfl', 'St. Louis Cardinals', 'ARI'),
        ('nfl', 'Baltimore Colts', 'IND'),
        ('nba', 'New Jersey Nets', 'BKN'),          ('nba', 'Seattle SuperSonics', 'OKC'),
        ('nba', 'Vancouver Grizzlies', 'MEM'),      ('nba', 'New Orleans Hornets', 'NOP'),
        ('nba', 'Charlotte Bobcats', 'CHA')
      ) v(league, team_name, abbr)
     WHERE v.league = p_league
  ),
  ids AS (
    SELECT i.id AS identity_id, i.name_slug,
           -- nflverse spells the Rams 'LA' and keeps historic codes on retired rows
           CASE i.latest_team WHEN 'LA' THEN 'LAR' WHEN 'STL' THEN 'LAR'
                              WHEN 'SD' THEN 'LAC' WHEN 'OAK' THEN 'LV'
                              ELSE i.latest_team END AS abbr,
           i.rookie_season, i.last_season
      FROM public.player_identities i
     WHERE i.league = p_league AND i.player_id IS NULL
  ),
  free_players AS (
    SELECT p.id AS player_id,
           regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') AS slug
      FROM public.players p
     WHERE p.collection_id = v_coll
       AND NOT EXISTS (SELECT 1 FROM public.player_identities x WHERE x.player_id = p.id)
  ),
  cand AS (
    SELECT ids.identity_id, fp.player_id, 'name'::text AS how,
           ids.abbr, ids.rookie_season, ids.last_season
      FROM ids
      JOIN free_players fp ON fp.slug = ids.name_slug
    UNION ALL
    -- a registered alias of a free player, only when no players row carries
    -- the league spelling itself (the two arms never both fire for one slug)
    SELECT ids.identity_id, a.player_id, 'alias'::text,
           ids.abbr, ids.rookie_season, ids.last_season
      FROM ids
      JOIN public.player_name_aliases a
        ON a.collection_id = v_coll AND a.alias_slug = ids.name_slug
     WHERE NOT EXISTS (SELECT 1 FROM free_players fp WHERE fp.slug = ids.name_slug)
       AND NOT EXISTS (SELECT 1 FROM public.player_identities x WHERE x.player_id = a.player_id)
  ),
  ev AS (
    SELECT c.*,
           EXISTS (SELECT 1
                     FROM public.editions e
                     JOIN team_abbr t ON t.team_name = e.team_name
                    WHERE e.player_id = c.player_id AND t.abbr = c.abbr) AS team_hit,
           EXISTS (SELECT 1
                     FROM public.editions e
                    WHERE e.player_id = c.player_id
                      AND e.game_date IS NOT NULL
                      AND c.rookie_season IS NOT NULL AND c.last_season IS NOT NULL
                      AND extract(year FROM e.game_date)::int
                          BETWEEN c.rookie_season - 1 AND c.last_season + 1) AS season_hit
      FROM cand c
  ),
  scored AS (
    SELECT ev.*,
           count(*)                            OVER (PARTITION BY ev.player_id)   AS n_ids,
           count(*)                            OVER (PARTITION BY ev.identity_id) AS n_players,
           count(*) FILTER (WHERE ev.team_hit)   OVER (PARTITION BY ev.player_id) AS n_team,
           count(*) FILTER (WHERE ev.season_hit) OVER (PARTITION BY ev.player_id) AS n_season
      FROM ev
  ),
  pick AS (
    SELECT s.identity_id, s.player_id,
           CASE
             WHEN s.n_players <> 1 THEN NULL
             WHEN s.n_ids = 1 THEN s.how
             WHEN s.n_team = 1 AND s.team_hit THEN s.how || '+team'
             WHEN s.n_team = 0 AND s.n_season = 1 AND s.season_hit THEN s.how || '+season'
             ELSE NULL
           END AS matched_by
      FROM scored s
  ),
  upd AS (
    UPDATE public.player_identities i
       SET player_id = pick.player_id, matched_by = pick.matched_by, matched_at = now()
      FROM pick
     WHERE i.id = pick.identity_id AND pick.matched_by IS NOT NULL
     RETURNING pick.matched_by
  )
  SELECT COALESCE(jsonb_object_agg(z.matched_by, z.n), '{}'::jsonb) INTO v_by
    FROM (SELECT u.matched_by, count(*)::int AS n FROM upd u GROUP BY u.matched_by) z;

  -- a player whose name matches a league row that is still free got NO link:
  -- two league rows share the name and nothing in the editions breaks the tie
  SELECT count(*) INTO v_amb
    FROM public.players p
   WHERE p.collection_id = v_coll
     AND NOT EXISTS (SELECT 1 FROM public.player_identities x WHERE x.player_id = p.id)
     AND EXISTS (SELECT 1 FROM public.player_identities i
                  WHERE i.league = p_league AND i.player_id IS NULL
                    AND i.name_slug = regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'));
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.player_identities x WHERE x.player_id = p.id))
    INTO v_players, v_unm
    FROM public.players p WHERE p.collection_id = v_coll;
  SELECT count(*), count(*) FILTER (WHERE i.player_id IS NULL)
    INTO v_ids, v_idsunl
    FROM public.player_identities i WHERE i.league = p_league;

  RETURN jsonb_build_object(
    'league', p_league,
    'matched', v_by,
    'players_total', v_players,
    'players_unmatched', v_unm,
    'players_ambiguous', v_amb,
    'identities_total', v_ids,
    'identities_unlinked', v_idsunl
  );
END
$function$;
REVOKE ALL ON FUNCTION public.match_player_identities(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_player_identities(text) TO service_role;

-- (4) the NBA half: Top Shot's real rows already carry the NBA person id
INSERT INTO public.player_identities
  (league, league_player_id, collection_id, player_id, matched_by, matched_at, name_slug, display_name, source)
SELECT 'nba', p.external_id, p.collection_id, p.id, 'external_id', now(),
       regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'),
       p.name, 'players.external_id'
  FROM public.players p
  JOIN public.collections c ON c.id = p.collection_id
 WHERE c.slug = 'nba_top_shot' AND p.external_id ~ '^[0-9]+$'
ON CONFLICT (league, league_player_id) DO NOTHING;

-- Post-conditions: every Top Shot row keyed by a person id has an identity,
-- and the crosswalk is invisible to anon.
DO $$
DECLARE v_missing int; v_n int;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.players p JOIN public.collections c ON c.id = p.collection_id
   WHERE c.slug = 'nba_top_shot' AND p.external_id ~ '^[0-9]+$'
     AND NOT EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = p.id);
  IF v_missing <> 0 THEN RAISE EXCEPTION 'player_identities: % Top Shot person-id rows without an identity', v_missing; END IF;
  SELECT count(*) INTO v_n FROM public.player_identities WHERE league = 'nba';
  IF v_n < 1000 THEN RAISE EXCEPTION 'player_identities: only % nba rows seeded', v_n; END IF;
  IF has_table_privilege('anon', 'public.player_identities', 'SELECT') THEN
    RAISE EXCEPTION 'player_identities: anon can read the crosswalk';
  END IF;
END $$;

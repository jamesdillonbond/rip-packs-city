-- 2026-09-25 (PT) — the name writers resolve through the league-id crosswalk:
-- closes the #139 watch item ("a future Cardinals edition labelled 'Marvin
-- Harrison' links to the Colts row until players resolve by id").
--
-- WHY. link_editions_to_players_by_name (pg_cron 612, daily 2:55 AM PT) links
-- an unlinked edition to THE ONE players row of that exact name. Two people
-- can share a label (All Day drops suffixes from series 7 on), so the label
-- alone cannot say which — the TEAM and the GAME DATE on the edition can, and
-- the crosswalk (20260925225610) now carries every league player's team and
-- seasons. ensure_players_from_edition_names (pg_cron 459, 2:50 AM PT) mints a
-- players row from a label whose slug resolves to nothing; for a person the
-- league knows, that mints the LABEL's spelling ("Foo Bar") where the league
-- says "Foo Bar Jr.".
--
-- WHAT.
-- (1) player_identities.base_slug — the name slug with a generational suffix
--     removed (marvin-harrison-jr- → marvin-harrison), generated + indexed, so
--     a suffix-less label finds the suffixed person.
-- (2) league_team_abbr(p_league) — one source for "edition team_name → league
--     abbreviation" (teams_master + the historic names). match_player_identities
--     now reads it instead of its inline copy (pin re-pointed; behaviour equal).
-- (3) resolve_player_identity(collection, name, team_name, game_date) → jsonb
--     {verdict: one | ambiguous | none, how: unique | team, identity_id,
--     player_id, display_name, name_slug, candidates}. Candidates are the
--     FEED-BACKED identities (rookie/last season known — the NBA half, seeded
--     from ids alone, has none yet and falls through to 'none') whose base_slug
--     matches and whose seasons contain the game year; one candidate is the
--     answer; several are decided by the edition's team, or declared ambiguous
--     — never guessed.
-- (4) link_editions_to_players_by_name — a FIRST arm through (3): 'one' links
--     the edition to the identity's player, MINTING the player with the
--     LEAGUE's spelling when the identity has none (and registering the label
--     as an alias when no row carries the label's own slug); 'ambiguous' is
--     counted in the run's extra and left unlinked; 'none' falls to the two
--     existing arms unchanged. Full-body write from the live prosrc
--     (md5 dc0d958d… re-read 2026-09-25 4:20 PM PT).
-- (5) ensure_players_from_edition_names — never mints a label whose base slug
--     matches a feed-backed identity: the linker mints that person with the
--     league's spelling instead. Spliced into the live body (md5 27fa8560…).
--
-- Revert: re-apply the bodies of 20260925135939 (both functions) ; DROP
-- FUNCTION public.resolve_player_identity(uuid, text, text, date); DROP
-- FUNCTION public.league_team_abbr(text); ALTER TABLE public.player_identities
-- DROP COLUMN base_slug; re-apply match_player_identities from 20260925225610.

-- (1)
ALTER TABLE public.player_identities
  ADD COLUMN IF NOT EXISTS base_slug text
  GENERATED ALWAYS AS (regexp_replace(name_slug, '-(jr|sr|ii|iii|iv|v)-?$', '')) STORED;
CREATE INDEX IF NOT EXISTS player_identities_league_base_slug_idx
  ON public.player_identities (league, base_slug);

-- (2)
-- anon-exec: intentional — league_team_abbr is a pure lookup over teams_master
-- (public data) plus a literal map; revoked below anyway, it is read by
-- SECURITY DEFINER callers.
CREATE OR REPLACE FUNCTION public.league_team_abbr(p_league text)
 RETURNS TABLE(team_name text, abbr text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.league_team_abbr(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.league_team_abbr(text) TO service_role;

-- (2b) match_player_identities: reads the shared map, gains the SUFFIX arm and the
--      team+season tie-break (pinned; re-pointed from 20260925225610)
-- anon-exec: intentional — full-body write of match_player_identities; the ACL
-- set in 20260925225610 (anon and authenticated revoked, service_role only) is
-- unchanged by CREATE OR REPLACE
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
    SELECT t.team_name, t.abbr FROM public.league_team_abbr(p_league) t
  ),
  ids AS (
    SELECT i.id AS identity_id, i.name_slug, i.base_slug,
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
  exact AS (
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
  cand AS (
    SELECT * FROM exact
    UNION ALL
    -- 2026-09-25 (batch 46): the SUFFIX arm — "Deebo Samuel" ↔ "Deebo Samuel
    -- Sr.", "Michael Pittman Jr." ↔ "Michael Pittman" — only for an identity
    -- AND a player that no exact arm touched, so a suffix-less father never
    -- competes with his own exact match for the son
    SELECT ids.identity_id, fp.player_id, 'suffix'::text,
           ids.abbr, ids.rookie_season, ids.last_season
      FROM ids
      JOIN free_players fp
        ON regexp_replace(fp.slug, '-(jr|sr|ii|iii|iv|v)-?$', '') = ids.base_slug
       AND fp.slug <> ids.name_slug
     WHERE NOT EXISTS (SELECT 1 FROM exact x WHERE x.identity_id = ids.identity_id)
       AND NOT EXISTS (SELECT 1 FROM exact x WHERE x.player_id = fp.player_id)
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
           count(*) FILTER (WHERE ev.season_hit) OVER (PARTITION BY ev.player_id) AS n_season,
           count(*) FILTER (WHERE ev.team_hit AND ev.season_hit) OVER (PARTITION BY ev.player_id) AS n_team_season
      FROM ev
  ),
  pick AS (
    SELECT s.identity_id, s.player_id,
           CASE
             WHEN s.n_players <> 1 THEN NULL
             WHEN s.n_ids = 1 THEN s.how
             WHEN s.n_team = 1 AND s.team_hit THEN s.how || '+team'
             -- two league rows on the same team (a 2006 and a 2021 "Cam Newton", both CAR): the seasons decide
             WHEN s.n_team > 1 AND s.team_hit AND s.n_team_season = 1 AND s.season_hit THEN s.how || '+team+season'
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

  -- a player whose (base) name matches a league row that is still free got NO
  -- link: league rows share the name and nothing in the editions breaks the tie
  SELECT count(*) INTO v_amb
    FROM public.players p
   WHERE p.collection_id = v_coll
     AND NOT EXISTS (SELECT 1 FROM public.player_identities x WHERE x.player_id = p.id)
     AND EXISTS (SELECT 1 FROM public.player_identities i
                  WHERE i.league = p_league AND i.player_id IS NULL
                    AND i.base_slug = regexp_replace(regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'), '-(jr|sr|ii|iii|iv|v)-?$', ''));
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

-- (3)
CREATE OR REPLACE FUNCTION public.resolve_player_identity(p_collection_id uuid, p_name text, p_team_name text, p_game_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_league text;
  v_base   text;
  v_year   int;
  v_abbr   text;
  v_n      int;
  v_nteam  int;
  v_row    record;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN jsonb_build_object('verdict', 'none', 'candidates', 0);
  END IF;
  SELECT CASE c.slug WHEN 'nba_top_shot' THEN 'nba' WHEN 'nfl_all_day' THEN 'nfl' END
    INTO v_league FROM public.collections c WHERE c.id = p_collection_id;
  IF v_league IS NULL THEN
    RETURN jsonb_build_object('verdict', 'none', 'candidates', 0);
  END IF;

  v_base := regexp_replace(
              regexp_replace(lower(trim(extensions.unaccent(p_name))), '[^a-z0-9]+', '-', 'g'),
              '-(jr|sr|ii|iii|iv|v)-?$', '');
  IF v_base = '' THEN
    RETURN jsonb_build_object('verdict', 'none', 'candidates', 0);
  END IF;
  v_year := extract(year FROM p_game_date)::int;
  IF p_team_name IS NOT NULL THEN
    SELECT t.abbr INTO v_abbr FROM public.league_team_abbr(v_league) t WHERE t.team_name = p_team_name LIMIT 1;
  END IF;

  -- feed-backed candidates whose seasons contain the game year
  SELECT count(*),
         count(*) FILTER (WHERE v_abbr IS NOT NULL AND v_abbr =
           CASE i.latest_team WHEN 'LA' THEN 'LAR' WHEN 'STL' THEN 'LAR'
                              WHEN 'SD' THEN 'LAC' WHEN 'OAK' THEN 'LV'
                              ELSE i.latest_team END)
    INTO v_n, v_nteam
    FROM public.player_identities i
   WHERE i.league = v_league AND i.base_slug = v_base
     AND i.rookie_season IS NOT NULL AND i.last_season IS NOT NULL
     AND (v_year IS NULL OR v_year BETWEEN i.rookie_season - 1 AND i.last_season + 1);

  IF v_n = 0 THEN
    RETURN jsonb_build_object('verdict', 'none', 'candidates', 0);
  END IF;

  IF v_n = 1 THEN
    SELECT i.id, i.player_id, i.display_name, i.name_slug INTO v_row
      FROM public.player_identities i
     WHERE i.league = v_league AND i.base_slug = v_base
       AND i.rookie_season IS NOT NULL AND i.last_season IS NOT NULL
       AND (v_year IS NULL OR v_year BETWEEN i.rookie_season - 1 AND i.last_season + 1);
    RETURN jsonb_build_object('verdict', 'one', 'how', 'unique', 'candidates', 1,
                              'identity_id', v_row.id, 'player_id', v_row.player_id,
                              'display_name', v_row.display_name, 'name_slug', v_row.name_slug);
  END IF;

  IF v_nteam = 1 THEN
    SELECT i.id, i.player_id, i.display_name, i.name_slug INTO v_row
      FROM public.player_identities i
     WHERE i.league = v_league AND i.base_slug = v_base
       AND i.rookie_season IS NOT NULL AND i.last_season IS NOT NULL
       AND (v_year IS NULL OR v_year BETWEEN i.rookie_season - 1 AND i.last_season + 1)
       AND v_abbr = CASE i.latest_team WHEN 'LA' THEN 'LAR' WHEN 'STL' THEN 'LAR'
                                        WHEN 'SD' THEN 'LAC' WHEN 'OAK' THEN 'LV'
                                        ELSE i.latest_team END;
    RETURN jsonb_build_object('verdict', 'one', 'how', 'team', 'candidates', v_n,
                              'identity_id', v_row.id, 'player_id', v_row.player_id,
                              'display_name', v_row.display_name, 'name_slug', v_row.name_slug);
  END IF;

  RETURN jsonb_build_object('verdict', 'ambiguous', 'candidates', v_n, 'team_hits', v_nteam);
END
$function$;
REVOKE ALL ON FUNCTION public.resolve_player_identity(uuid, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_player_identity(uuid, text, text, date) TO service_role;

-- (4)
-- anon-exec: intentional — full-body write of link_editions_to_players_by_name
-- (the pg_cron 612 job); its ACL is unchanged by CREATE OR REPLACE
CREATE OR REPLACE FUNCTION public.link_editions_to_players_by_name(p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_linked  int := 0;
  v_ident   int := 0;
  v_minted  int := 0;
  v_amb     int := 0;
  v_blocked int := 0;
  v_legacy  int := 0;
  v_ok      boolean := true;
  v_err     text;
BEGIN
  BEGIN
    WITH unl AS (
      SELECT e.id AS edition_id, e.collection_id, e.player_name, e.team_name, e.game_date
      FROM public.editions e
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND e.player_name IS DISTINCT FROM e.team_name
        AND lower(btrim(e.player_name)) <> 'team moment'
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
    ),
    -- 2026-09-25: the identity arm. The league-id crosswalk decides by base
    -- name + game year + team; 'one' links (minting the league's spelling
    -- when RPC has no row), 'ambiguous' is counted and left, 'none' falls
    -- to the name/alias arms below.
    res AS (
      SELECT u.*,
             r->>'verdict'              AS verdict,
             (r->>'identity_id')::uuid  AS identity_id,
             (r->>'player_id')::uuid    AS ident_player_id,
             r->>'display_name'         AS display_name,
             r->>'name_slug'            AS name_slug,
             regexp_replace(lower(trim(extensions.unaccent(u.player_name))), '[^a-z0-9]+', '-', 'g') AS label_slug
      FROM unl u
      CROSS JOIN LATERAL public.resolve_player_identity(u.collection_id, u.player_name, u.team_name, u.game_date) r
    ),
    to_mint AS (
      SELECT DISTINCT ON (r.identity_id) r.identity_id, r.collection_id, r.display_name, r.name_slug, r.team_name, c.slug AS coll_slug
      FROM res r JOIN public.collections c ON c.id = r.collection_id
      WHERE r.verdict = 'one' AND r.ident_player_id IS NULL
        -- a row already keyed by that slug belongs to someone else: do not
        -- steal it, leave the edition unlinked and count it (mint_blocked)
        AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.external_id = c.slug || '-' || r.name_slug)
      ORDER BY r.identity_id, r.game_date DESC NULLS LAST
    ),
    minted AS (
      INSERT INTO public.players (external_id, collection_id, name, team, collection)
      SELECT m.coll_slug || '-' || m.name_slug, m.collection_id, m.display_name, m.team_name, m.coll_slug
      FROM to_mint m
      ON CONFLICT (external_id) DO NOTHING
      RETURNING id, external_id
    ),
    linked_ident AS (
      UPDATE public.player_identities i
         SET player_id = m.id, matched_by = 'linker', matched_at = now()
        FROM to_mint t
        JOIN minted m ON m.external_id = t.coll_slug || '-' || t.name_slug
       WHERE i.id = t.identity_id AND i.player_id IS NULL
       RETURNING i.id AS identity_id, i.player_id
    ),
    ident_target AS (
      SELECT r.edition_id, r.collection_id, r.label_slug, r.name_slug,
             COALESCE(r.ident_player_id, li.player_id) AS player_id
      FROM res r
      LEFT JOIN linked_ident li ON li.identity_id = r.identity_id
      WHERE r.verdict = 'one'
    ),
    -- the label's own slug becomes an alias of the league-spelt row, only when
    -- no players row carries that slug (an existing row keeps its URL)
    aliased AS (
      INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
      SELECT DISTINCT ON (t.collection_id, t.label_slug) t.collection_id, t.label_slug, t.player_id,
             'linker ' || to_char(now(), 'YYYY-MM-DD') || ': edition label for ' || t.name_slug
      FROM ident_target t
      WHERE t.player_id IS NOT NULL AND t.label_slug <> t.name_slug
        AND NOT EXISTS (SELECT 1 FROM public.players p
                         WHERE p.collection_id = t.collection_id
                           AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = t.label_slug)
      ORDER BY t.collection_id, t.label_slug, t.player_id
      ON CONFLICT (collection_id, alias_slug) DO NOTHING
      RETURNING 1
    ),
    upd_ident AS (
      UPDATE public.editions e
         SET player_id = t.player_id
        FROM ident_target t
       WHERE e.id = t.edition_id AND e.player_id IS NULL AND t.player_id IS NOT NULL
      RETURNING e.id, e.player_id
    ),
    cand AS (
      SELECT e.id AS edition_id, p.id AS player_id
      FROM public.editions e
      JOIN public.players p
        ON p.collection_id = e.collection_id
       AND lower(extensions.unaccent(btrim(p.name))) = lower(extensions.unaccent(btrim(e.player_name)))
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND e.player_name IS DISTINCT FROM e.team_name
        AND lower(btrim(e.player_name)) <> 'team moment'
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
        AND NOT EXISTS (SELECT 1 FROM res r WHERE r.edition_id = e.id AND r.verdict <> 'none')
        -- exactly one players row of that name (accent- and case-folded) in that collection
        AND (SELECT count(*) FROM public.players p2
              WHERE p2.collection_id = e.collection_id
                AND lower(extensions.unaccent(btrim(p2.name))) = lower(extensions.unaccent(btrim(e.player_name)))) = 1
      UNION ALL
      -- 2026-09-25: a registered ALIAS links to its player, only when no
      -- players row carries that spelling itself (so the two arms never both fire)
      SELECT e.id AS edition_id, a.player_id
      FROM public.editions e
      JOIN public.player_name_aliases a
        ON a.collection_id = e.collection_id
       AND a.alias_slug = regexp_replace(lower(trim(extensions.unaccent(e.player_name))), '[^a-z0-9]+', '-', 'g')
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
        AND NOT EXISTS (SELECT 1 FROM res r WHERE r.edition_id = e.id AND r.verdict <> 'none')
        AND NOT EXISTS (SELECT 1 FROM public.players p2
                         WHERE p2.collection_id = e.collection_id
                           AND lower(extensions.unaccent(btrim(p2.name))) = lower(extensions.unaccent(btrim(e.player_name))))
    ),
    upd AS (
      UPDATE public.editions e
         SET player_id = c.player_id
        FROM cand c
       WHERE e.id = c.edition_id AND e.player_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM upd_ident ui WHERE ui.id = e.id)
      RETURNING e.id, e.player_id
    ),
    bk AS (
      INSERT INTO public.audit_20260925_edition_player_link_backup (edition_id, player_id)
      SELECT id, player_id FROM upd
      UNION ALL
      SELECT id, player_id FROM upd_ident
      ON CONFLICT (edition_id) DO NOTHING
    )
    SELECT (SELECT count(*)::int FROM upd),
           (SELECT count(*)::int FROM upd_ident),
           (SELECT count(*)::int FROM minted),
           (SELECT count(*)::int FROM res WHERE verdict = 'ambiguous'),
           (SELECT count(*)::int FROM ident_target WHERE player_id IS NULL)
      INTO v_legacy, v_ident, v_minted, v_amb, v_blocked;
    v_linked := v_legacy + v_ident;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
    v_linked := 0;
  END;

  PERFORM public.log_pipeline_run(
    'editions-player-link', v_started,
    v_linked, v_linked, 0, v_ok, v_err,
    NULL, NULL, NULL,
    jsonb_build_object('scope', COALESCE(p_collection_id::text, 'all'), 'rows_written', v_linked,
                       'by_identity', v_ident, 'players_minted', v_minted, 'identity_ambiguous', v_amb, 'mint_blocked', v_blocked,
                       'by_name_or_alias', v_legacy,
                       'elapsed_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000))
  );
  IF NOT v_ok THEN
    RAISE EXCEPTION 'link_editions_to_players_by_name: %', v_err;
  END IF;
  RETURN v_linked;
END;
$function$;

-- (5) ensure_players_from_edition_names: splice one predicate into the live body
-- anon-exec: intentional — spliced re-create of ensure_players_from_edition_names
-- (the pg_cron 459 job); its ACL is unchanged by CREATE OR REPLACE
DO $$
DECLARE
  v_src    text;
  v_anchor text := E'       -- 2026-09-25: nor may it be a registered ALIAS of an existing player\n';
  v_add    text := E'       -- 2026-09-25 (identity): nor a label the LEAGUE knows under its own spelling —\n'
                || E'       -- the linker mints that person from the crosswalk (league_team_abbr /\n'
                || E'       -- resolve_player_identity), never the label''s spelling\n'
                || E'       AND NOT EXISTS (\n'
                || E'             SELECT 1\n'
                || E'               FROM public.player_identities i\n'
                || E'              WHERE i.collection_id = e.collection_id\n'
                || E'                AND i.rookie_season IS NOT NULL AND i.last_season IS NOT NULL\n'
                || E'                AND i.base_slug = regexp_replace(\n'
                || E'                      regexp_replace(lower(trim(extensions.unaccent(e.player_name))), ''[^a-z0-9]+'', ''-'', ''g''),\n'
                || E'                      ''-(jr|sr|ii|iii|iv|v)-?$'', '''')\n'
                || E'           )\n';
  v_n      int;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ensure_players_from_edition_names';
  IF v_src IS NULL THEN RAISE EXCEPTION 'ensure_players_from_edition_names: not found'; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ensure_players_from_edition_names: anchor found % times, want 1', v_n; END IF;
  IF position('i.base_slug' IN v_src) > 0 THEN RAISE EXCEPTION 'ensure_players_from_edition_names: already spliced'; END IF;
  v_src := replace(v_src, v_anchor, v_add || v_anchor);
  EXECUTE 'CREATE OR REPLACE FUNCTION public.ensure_players_from_edition_names(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 5000)'
       || ' RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS '
       || quote_literal(v_src);
END $$;

-- Post-conditions: the resolver decides the two cases that motivated it, on
-- the live crosswalk once nflverse has loaded (skipped, with a NOTICE, if the
-- NFL half is still empty — the sync route fills it); the ensure splice landed.
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.player_identities WHERE league = 'nfl' AND rookie_season IS NOT NULL;
  IF v_n = 0 THEN
    RAISE NOTICE 'player_identities: no feed-backed nfl rows yet — resolver post-conditions skipped';
  ELSE
    r := public.resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', 'Arizona Cardinals', '2026-09-20');
    IF r->>'verdict' <> 'one' OR r->>'display_name' <> 'Marvin Harrison Jr.' THEN
      RAISE EXCEPTION 'resolve_player_identity: Cardinals 2026 "Marvin Harrison" -> %', r;
    END IF;
    r := public.resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', 'Indianapolis Colts', '2006-11-05');
    IF r->>'verdict' <> 'one' OR r->>'display_name' <> 'Marvin Harrison' THEN
      RAISE EXCEPTION 'resolve_player_identity: Colts 2006 "Marvin Harrison" -> %', r;
    END IF;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc WHERE proname = 'ensure_players_from_edition_names' AND prosrc LIKE '%i.base_slug%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'ensure_players_from_edition_names: splice missing'; END IF;
END $$;

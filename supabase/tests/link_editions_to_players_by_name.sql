-- DB invariant: public.link_editions_to_players_by_name(uuid) — the daily
-- linker (pg_cron 612) that attaches an unlinked edition to a players row.
-- Pinned 2026-09-25 when it gained its FIRST arm through the league-id
-- crosswalk (#139 follow-up). The properties: an edition the crosswalk decides
-- ('one') links to THAT person — minting the row with the LEAGUE's spelling
-- when RPC has none, and aliasing the label's slug only when no row owns it;
-- an 'ambiguous' label is COUNTED and left unlinked (never the exact-spelling
-- row); a label the crosswalk does not know ('none') takes the two legacy arms
-- unchanged (unique exact name, then alias); every link is backed up; the run
-- row carries the split.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260926004758_audit_20260925_city_labelled_team_moments_belong_to_the_franchise_row.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);
INSERT INTO collections VALUES ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
                               ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
CREATE TABLE teams_master (league text, team_name text, abbreviation text);
INSERT INTO teams_master VALUES
  ('NFL', 'Arizona Cardinals', 'ARI'), ('NFL', 'Indianapolis Colts', 'IND'),
  ('NFL', 'Buffalo Bills', 'BUF'), ('NBA', 'Golden State Warriors', 'GSW');

CREATE TABLE players (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE,
  collection_id uuid,
  name          text,
  team          text,
  collection    text,
  updated_at    timestamptz DEFAULT now()
);
CREATE TABLE editions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid,
  player_id     uuid,
  player_name   text,
  team_name     text,
  game_date     date
);
CREATE TABLE player_name_aliases (
  collection_id uuid NOT NULL, alias_slug text NOT NULL, player_id uuid NOT NULL, note text,
  PRIMARY KEY (collection_id, alias_slug)
);
CREATE TABLE player_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league text NOT NULL, league_player_id text NOT NULL, collection_id uuid NOT NULL,
  player_id uuid, matched_by text, matched_at timestamptz,
  name_slug text NOT NULL, display_name text NOT NULL,
  latest_team text, rookie_season int, last_season int,
  base_slug text GENERATED ALWAYS AS (regexp_replace(name_slug, '-(jr|sr|ii|iii|iv|v)-?$', '')) STORED
);
CREATE UNIQUE INDEX player_identities_player_id_uidx ON player_identities (player_id) WHERE player_id IS NOT NULL;
CREATE TABLE audit_20260925_edition_player_link_backup (edition_id uuid PRIMARY KEY, player_id uuid, backed_up_at timestamptz DEFAULT now());
CREATE TABLE _runs (pipeline text, ok boolean, err text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int, p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS void LANGUAGE sql AS $$ INSERT INTO _runs VALUES (p_pipeline, p_ok, p_error, p_extra) $$;

-- fixture copies of the two functions the linker calls (each pinned in its own file)
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

-- >>> BEGIN verbatim link_editions_to_players_by_name (keep byte-identical to the migration) >>>
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
      UNION ALL
      -- 2026-09-25 (batch 54): a team moment labelled by its CITY ("Buffalo" on
      -- a Buffalo Bills "Banner Year" edition) links to the franchise row named
      -- after the team — never to a person, never to a row minted for the city
      SELECT e.id AS edition_id, f.id AS player_id
      FROM public.editions e
      JOIN public.players f
        ON f.collection_id = e.collection_id
       AND f.name = e.team_name
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND e.team_name IS NOT NULL
        AND e.team_name LIKE btrim(e.player_name) || ' %'
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
        AND NOT EXISTS (SELECT 1 FROM res r WHERE r.edition_id = e.id AND r.verdict <> 'none')
        AND NOT EXISTS (SELECT 1 FROM public.players p2
                         WHERE p2.collection_id = e.collection_id
                           AND lower(extensions.unaccent(btrim(p2.name))) = lower(extensions.unaccent(btrim(e.player_name))))
        AND (SELECT count(*) FROM public.players f2
              WHERE f2.collection_id = e.collection_id AND f2.name = e.team_name) = 1
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
-- <<< END verbatim link_editions_to_players_by_name <<<

-- ── fixtures ──────────────────────────────────────────────────────────────────
INSERT INTO players (id, external_id, collection_id, name, collection) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'nfl_all_day-marvin-harrison-jr-', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison Jr.', 'nfl_all_day'),
  ('a0000000-0000-0000-0000-000000000002', 'nfl_all_day-marvin-harrison',     'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison',     'nfl_all_day'),
  ('a0000000-0000-0000-0000-000000000003', 'nfl_all_day-nobody-known',        'dee28451-5d62-409e-a1ad-a83f763ac070', 'Nobody Known',        'nfl_all_day'),
  ('a0000000-0000-0000-0000-000000000004', 'nfl_all_day-zed-zed',             'dee28451-5d62-409e-a1ad-a83f763ac070', 'Zed Zed',             'nfl_all_day'),
  ('a0000000-0000-0000-0000-000000000005', '201939',                          '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Steph Curry',         'nba_top_shot'),
  ('a0000000-0000-0000-0000-000000000006', 'nfl_all_day-buffalo-bills',       'dee28451-5d62-409e-a1ad-a83f763ac070', 'Buffalo Bills',       'nfl_all_day');
INSERT INTO player_name_aliases VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'stephen-curry', 'a0000000-0000-0000-0000-000000000005', 'test');

INSERT INTO player_identities (id, league, league_player_id, collection_id, player_id, name_slug, display_name, latest_team, rookie_season, last_season) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'nfl', '00-0039849', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000001', 'marvin-harrison-jr-', 'Marvin Harrison Jr.', 'ARI', 2024, 2026),
  ('b0000000-0000-0000-0000-000000000002', 'nfl', '00-0007024', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000002', 'marvin-harrison',     'Marvin Harrison',     'IND', 1996, 2008),
  -- a rookie the league spells with a suffix; RPC has no row yet
  ('b0000000-0000-0000-0000-000000000003', 'nfl', '00-0040001', 'dee28451-5d62-409e-a1ad-a83f763ac070', NULL, 'foo-bar-jr-', 'Foo Bar Jr.', 'BUF', 2025, 2026),
  -- an unlinked identity whose slug is already owned by a players row (someone else)
  ('b0000000-0000-0000-0000-000000000004', 'nfl', '00-0040002', 'dee28451-5d62-409e-a1ad-a83f763ac070', NULL, 'zed-zed', 'Zed Zed', 'BUF', 2022, 2026),
  ('b0000000-0000-0000-0000-000000000009', 'nfl', '00-0040009', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000004', 'zed-zed-ii', 'Zed Zed II', 'IND', 2010, 2015);

INSERT INTO editions (id, collection_id, player_name, team_name, game_date) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', 'Arizona Cardinals',  '2026-09-20'), -- THE case
  ('e0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', 'Indianapolis Colts', '2005-10-02'), -- the father
  ('e0000000-0000-0000-0000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', NULL,                 NULL),         -- ambiguous
  ('e0000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Foo Bar',         'Buffalo Bills',      '2025-11-02'), -- mint Jr.
  ('e0000000-0000-0000-0000-000000000005', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Foo Bar',         'Buffalo Bills',      '2026-09-13'), -- same person, one mint
  ('e0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Nobody Known',    'Buffalo Bills',      '2024-01-01'), -- legacy exact name
  ('e0000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Zed Zed',         'Buffalo Bills',      '2024-01-01'), -- mint blocked
  ('e0000000-0000-0000-0000-000000000008', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Stephen Curry',   'Golden State Warriors', '2024-01-01'), -- legacy alias
  ('e0000000-0000-0000-0000-000000000009', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Buffalo Bills',   'Buffalo Bills',      '2024-01-01'), -- team moment: untouched
  ('e0000000-0000-0000-0000-000000000010', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Team Moment',     'Buffalo Bills',      '2024-01-01'),
  ('e0000000-0000-0000-0000-000000000011', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Buffalo',         'Buffalo Bills',      '2025-09-07'); -- city label → the franchise row

DO $$
DECLARE n int; x jsonb; v_jr uuid;
BEGIN
  n := link_editions_to_players_by_name(NULL);
  PERFORM _assert_eq(n::text, '7', 'seven editions linked: 4 by identity (2 on the minted row) + 3 legacy');

  -- 1. THE case: the Cardinals 2026 label went to Jr., the Colts 2005 to Sr.
  PERFORM _assert_eq((SELECT player_id::text FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000001'),
                     'a0000000-0000-0000-0000-000000000001', 'Cardinals 2026 "Marvin Harrison" -> Jr.');
  PERFORM _assert_eq((SELECT player_id::text FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000002'),
                     'a0000000-0000-0000-0000-000000000002', 'Colts 2005 "Marvin Harrison" -> Sr.');

  -- 2. ambiguous stays unlinked — NOT the exact-spelling row
  PERFORM _assert((SELECT player_id IS NULL FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000003'), 'no-evidence Harrison stays unlinked');

  -- 3. the rookie is minted ONCE, with the LEAGUE spelling, identity linked, label aliased
  SELECT id INTO v_jr FROM players WHERE external_id = 'nfl_all_day-foo-bar-jr-';
  PERFORM _assert(v_jr IS NOT NULL, 'Foo Bar Jr. minted');
  PERFORM _assert_eq((SELECT name FROM players WHERE id = v_jr), 'Foo Bar Jr.', 'minted with the league spelling');
  PERFORM _assert_eq((SELECT team FROM players WHERE id = v_jr), 'Buffalo Bills', 'minted with the edition team');
  PERFORM _assert_eq((SELECT count(*)::text FROM players WHERE name LIKE 'Foo Bar%'), '1', 'one row for two editions');
  PERFORM _assert_eq((SELECT player_id::text FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000004'), v_jr::text, 'edition 4 -> minted row');
  PERFORM _assert_eq((SELECT player_id::text FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000005'), v_jr::text, 'edition 5 -> minted row');
  PERFORM _assert_eq((SELECT player_id::text || '|' || matched_by FROM player_identities WHERE id = 'b0000000-0000-0000-0000-000000000003'), v_jr::text || '|linker', 'identity linked by the linker');
  PERFORM _assert_eq((SELECT player_id::text FROM player_name_aliases WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND alias_slug = 'foo-bar'), v_jr::text, 'label slug aliased to the row');

  -- 4. an alias is NOT registered over a slug a players row owns
  PERFORM _assert((SELECT count(*) = 0 FROM player_name_aliases WHERE alias_slug = 'marvin-harrison'), 'marvin-harrison is Sr.''s URL, never an alias');

  -- 5. a mint whose slug is owned by another row is BLOCKED: nothing stolen, edition unlinked, counted
  PERFORM _assert_eq((SELECT name FROM players WHERE external_id = 'nfl_all_day-zed-zed'), 'Zed Zed', 'the owned row is untouched');
  PERFORM _assert((SELECT player_id IS NULL FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000007'), 'blocked mint leaves the edition unlinked');
  PERFORM _assert((SELECT player_id IS NULL FROM player_identities WHERE id = 'b0000000-0000-0000-0000-000000000004'), 'blocked identity stays unlinked');

  -- 6. legacy arms still fire for labels the crosswalk does not know
  PERFORM _assert_eq((SELECT player_id::text FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000006'), 'a0000000-0000-0000-0000-000000000003', 'exact unique name -> legacy link');
  PERFORM _assert_eq((SELECT player_id::text FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000008'), 'a0000000-0000-0000-0000-000000000005', 'alias -> legacy link');
  PERFORM _assert((SELECT player_id IS NULL FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000009'), 'team-named edition untouched');
  PERFORM _assert((SELECT player_id IS NULL FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000010'), 'Team Moment untouched');
  -- 2026-09-25 (batch 54): a CITY label links to the franchise row named after its team
  PERFORM _assert_eq((SELECT player_id::text FROM editions WHERE id = 'e0000000-0000-0000-0000-000000000011'), 'a0000000-0000-0000-0000-000000000006', '"Buffalo" on a Bills edition -> the Buffalo Bills row');
  PERFORM _assert((SELECT count(*) = 0 FROM players WHERE name = 'Buffalo'), 'no "Buffalo" person minted');

  -- 7. every link is backed up; the run row carries the split
  PERFORM _assert_eq((SELECT count(*)::text FROM audit_20260925_edition_player_link_backup), '7', 'seven backup rows');
  SELECT extra INTO x FROM _runs WHERE pipeline = 'editions-player-link';
  PERFORM _assert((SELECT ok FROM _runs WHERE pipeline = 'editions-player-link'), 'run ok');
  PERFORM _assert_eq(x->>'by_identity', '4', 'by_identity: 2 Harrisons + 2 Foo Bars');
  PERFORM _assert_eq(x->>'players_minted', '1', 'players_minted');
  PERFORM _assert_eq(x->>'identity_ambiguous', '1', 'identity_ambiguous');
  PERFORM _assert_eq(x->>'mint_blocked', '1', 'mint_blocked');
  PERFORM _assert_eq(x->>'by_name_or_alias', '3', 'by_name_or_alias (incl. the city label)');
  PERFORM _assert_eq(x->>'rows_written', '7', 'rows_written = links made');

  -- 8. a second run links nothing new and re-reports the debt
  DELETE FROM _runs;
  n := link_editions_to_players_by_name(NULL);
  PERFORM _assert_eq(n::text, '0', 'second run: nothing new');
  SELECT extra INTO x FROM _runs WHERE pipeline = 'editions-player-link';
  PERFORM _assert_eq(x->>'identity_ambiguous', '1', 'ambiguity re-reported');
  PERFORM _assert_eq(x->>'mint_blocked', '1', 'blocked mint re-reported');
  PERFORM _assert_eq((SELECT count(*)::text FROM players), '7', 'no second mint');
END $$;

ROLLBACK;

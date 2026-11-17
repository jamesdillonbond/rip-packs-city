-- DB invariant: public.resolve_player_identity(uuid, text, text, date) — the
-- league-id crosswalk's answer to "which person is this edition label?".
-- Added 2026-09-25 (#139 follow-up; closes the watch item "a future Cardinals
-- edition labelled 'Marvin Harrison' links to the Colts row"). The property:
-- candidates are the FEED-BACKED identities whose base name (suffix removed)
-- matches and whose seasons contain the game year; one candidate is the
-- answer; several are decided by the edition's team or declared ambiguous —
-- never guessed; identities without season data (the id-only NBA half) do
-- not take part, so the legacy name arms keep those collections unchanged.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925232127_audit_20260925_name_writers_resolve_through_the_player_identity_crosswalk.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);
INSERT INTO collections VALUES ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
                               ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'),
                               ('11111111-1111-1111-1111-111111111111', 'ufc_strike');
CREATE TABLE teams_master (league text, team_name text, abbreviation text);
INSERT INTO teams_master VALUES
  ('NFL', 'Arizona Cardinals', 'ARI'), ('NFL', 'Indianapolis Colts', 'IND'),
  ('NFL', 'Buffalo Bills', 'BUF'), ('NFL', 'Jacksonville Jaguars', 'JAX'),
  ('NFL', 'Los Angeles Rams', 'LAR'), ('NBA', 'Golden State Warriors', 'GSW');

CREATE TABLE player_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league text NOT NULL, league_player_id text NOT NULL, collection_id uuid NOT NULL,
  player_id uuid, name_slug text NOT NULL, display_name text NOT NULL,
  latest_team text, rookie_season int, last_season int,
  base_slug text GENERATED ALWAYS AS (regexp_replace(name_slug, '-(jr|sr|ii|iii|iv|v)-?$', '')) STORED
);

-- the shared team map (its own migration; a fixture copy here)
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

-- >>> BEGIN verbatim resolve_player_identity (keep byte-identical to the migration) >>>
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
-- <<< END verbatim resolve_player_identity <<<

INSERT INTO player_identities (id, league, league_player_id, collection_id, player_id, name_slug, display_name, latest_team, rookie_season, last_season) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'nfl', '00-0039849', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000001', 'marvin-harrison-jr-', 'Marvin Harrison Jr.', 'ARI', 2024, 2026),
  ('b0000000-0000-0000-0000-000000000002', 'nfl', '00-0007024', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000002', 'marvin-harrison',     'Marvin Harrison',     'IND', 1996, 2008),
  ('b0000000-0000-0000-0000-000000000003', 'nfl', '00-0034857', 'dee28451-5d62-409e-a1ad-a83f763ac070', NULL,                                   'josh-allen',          'Josh Allen',          'BUF', 2018, 2026),
  ('b0000000-0000-0000-0000-000000000004', 'nfl', '00-0030833', 'dee28451-5d62-409e-a1ad-a83f763ac070', NULL,                                   'josh-allen',          'Josh Allen',          'TB',  2011, 2016),
  ('b0000000-0000-0000-0000-000000000005', 'nfl', '00-0033536', 'dee28451-5d62-409e-a1ad-a83f763ac070', NULL,                                   'mike-williams',       'Mike Williams',       'LA',  2017, 2024),
  ('b0000000-0000-0000-0000-000000000006', 'nfl', '00-0027986', 'dee28451-5d62-409e-a1ad-a83f763ac070', NULL,                                   'mike-williams',       'Mike Williams',       'TB',  2010, 2014),
  -- the id-only NBA half: no seasons, so it must not take part
  ('b0000000-0000-0000-0000-000000000007', 'nba', '56',      '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a0000000-0000-0000-0000-000000000007', 'gary-payton',    'Gary Payton',    NULL, NULL, NULL),
  ('b0000000-0000-0000-0000-000000000008', 'nba', '1627780', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a0000000-0000-0000-0000-000000000008', 'gary-payton-ii', 'Gary Payton II', NULL, NULL, NULL);

DO $$
DECLARE r jsonb;
BEGIN
  -- 1. THE case: a suffix-less Cardinals label in 2026 is the son, by season alone
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', 'Arizona Cardinals', '2026-09-20');
  PERFORM _assert_eq(r->>'verdict', 'one', 'Cardinals 2026: one');
  PERFORM _assert_eq(r->>'identity_id', 'b0000000-0000-0000-0000-000000000001', 'Cardinals 2026 -> Jr.');
  PERFORM _assert_eq(r->>'display_name', 'Marvin Harrison Jr.', 'the league spelling comes back');
  PERFORM _assert_eq(r->>'player_id', 'a0000000-0000-0000-0000-000000000001', 'Jr. player id');

  -- 2. the father, by season
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', 'Indianapolis Colts', '2006-11-05');
  PERFORM _assert_eq(r->>'identity_id', 'b0000000-0000-0000-0000-000000000002', 'Colts 2006 -> Sr.');

  -- 3. no date: two candidates, the TEAM decides
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', 'Arizona Cardinals', NULL);
  PERFORM _assert_eq(r->>'verdict', 'one', 'no date, Cardinals: one');
  PERFORM _assert_eq(r->>'how', 'team', 'decided by team');
  PERFORM _assert_eq(r->>'identity_id', 'b0000000-0000-0000-0000-000000000001', 'no date, Cardinals -> Jr.');

  -- 4. no date, no team: ambiguous — NOT the exact-spelling row
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison', NULL, NULL);
  PERFORM _assert_eq(r->>'verdict', 'ambiguous', 'no evidence: ambiguous');
  PERFORM _assert_eq(r->>'candidates', '2', 'both Harrisons were candidates');

  -- 5. a label with the suffix still matches (base slug on both sides)
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison Jr.', NULL, '2025-01-05');
  PERFORM _assert_eq(r->>'identity_id', 'b0000000-0000-0000-0000-000000000001', 'suffixed label -> Jr.');

  -- 6. a team that contradicts every candidate is ambiguous, not a guess
  --    (the Jaguars "Josh Allen" is a third person the feed spells Hines-Allen)
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Allen', 'Jacksonville Jaguars', NULL);
  PERFORM _assert_eq(r->>'verdict', 'ambiguous', 'JAX Josh Allen, no date: ambiguous');
  PERFORM _assert_eq(r->>'team_hits', '0', 'no candidate carries JAX');
  -- with a date the season filter leaves one candidate and it IS taken (the
  -- residual this design accepts: a person absent from the feed is unknowable)
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Allen', 'Buffalo Bills', '2023-12-17');
  PERFORM _assert_eq(r->>'identity_id', 'b0000000-0000-0000-0000-000000000003', 'Bills 2023 -> the QB');
  PERFORM _assert((r->>'player_id') IS NULL, 'an unlinked identity comes back with player_id NULL (the linker mints)');

  -- 7. nflverse LA normalises to LAR for the team decision
  r := resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Mike Williams', 'Los Angeles Rams', NULL);
  PERFORM _assert_eq(r->>'identity_id', 'b0000000-0000-0000-0000-000000000005', 'Rams -> the LA row');

  -- 8. the NBA half has no season data: 'none', so the legacy arms decide
  r := resolve_player_identity('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Gary Payton', 'Golden State Warriors', '2021-05-01');
  PERFORM _assert_eq(r->>'verdict', 'none', 'id-only identities do not take part');

  -- 9. unknown people, other collections, blanks
  PERFORM _assert_eq(resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', 'Nobody Known', NULL, NULL)->>'verdict', 'none', 'unknown -> none');
  PERFORM _assert_eq(resolve_player_identity('11111111-1111-1111-1111-111111111111', 'Marvin Harrison', NULL, NULL)->>'verdict', 'none', 'no league -> none');
  PERFORM _assert_eq(resolve_player_identity('dee28451-5d62-409e-a1ad-a83f763ac070', '  ', NULL, NULL)->>'verdict', 'none', 'blank -> none');
  PERFORM _assert_eq(resolve_player_identity(NULL, 'Marvin Harrison', NULL, NULL)->>'verdict', 'none', 'null collection -> none');
END $$;

ROLLBACK;

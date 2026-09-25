-- DB invariant: public.match_player_identities(text) — links a league's player
-- rows (player_identities: NBA person id / NFL GSIS id, the league's spelling)
-- to RPC's players rows. Added 2026-09-25 (#139 follow-up, the long-term
-- identity plan). The property under test: a player is linked by NAME only when
-- the name is unique both ways; when two league rows share a name the tie is
-- broken by the TEAM the player's editions carry, then by season overlap; a tie
-- nothing breaks is COUNTED (players_ambiguous) and left NULL — never guessed.
-- A wrong result puts the Bills quarterback's editions on a 2016 Buccaneers
-- centre, or the Cardinals rookie on his Colts father.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925225610_audit_20260925_player_identities_crosswalk_table_upsert_and_match.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);
INSERT INTO collections VALUES ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
                               ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');

CREATE TABLE players (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE,
  collection_id uuid,
  name          text
);

CREATE TABLE editions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   uuid,
  team_name   text,
  game_date   date
);

CREATE TABLE player_name_aliases (
  collection_id uuid NOT NULL,
  alias_slug    text NOT NULL,
  player_id     uuid NOT NULL,
  PRIMARY KEY (collection_id, alias_slug)
);

-- prod's `league` is an enum; the function casts it to text, so text serves here
CREATE TABLE teams_master (league text, team_name text, abbreviation text);
INSERT INTO teams_master VALUES
  ('NFL', 'Buffalo Bills', 'BUF'), ('NFL', 'Tampa Bay Buccaneers', 'TB'),
  ('NFL', 'Arizona Cardinals', 'ARI'), ('NFL', 'Indianapolis Colts', 'IND'),
  ('NFL', 'Los Angeles Rams', 'LAR'), ('NFL', 'Jacksonville Jaguars', 'JAX');

CREATE TABLE player_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league           text NOT NULL CHECK (league IN ('nba', 'nfl')),
  league_player_id text NOT NULL,
  collection_id    uuid NOT NULL,
  player_id        uuid,
  matched_by       text,
  matched_at       timestamptz,
  name_slug        text NOT NULL,
  display_name     text NOT NULL,
  latest_team      text,
  rookie_season    int,
  last_season      int,
  source           text NOT NULL DEFAULT 'test',
  UNIQUE (league, league_player_id)
);
CREATE UNIQUE INDEX player_identities_player_id_uidx ON player_identities (player_id) WHERE player_id IS NOT NULL;

-- >>> BEGIN verbatim match_player_identities (keep byte-identical to the migration) >>>
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
-- <<< END verbatim match_player_identities <<<

-- ── fixtures ──────────────────────────────────────────────────────────────────
-- AD players
INSERT INTO players (id, external_id, collection_id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ad-marvin-harrison-jr-', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison Jr.'),
  ('a0000000-0000-0000-0000-000000000002', 'ad-marvin-harrison',     'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison'),
  ('a0000000-0000-0000-0000-000000000003', 'ad-josh-allen',          'dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Allen'),
  ('a0000000-0000-0000-0000-000000000004', 'ad-mike-williams',       'dee28451-5d62-409e-a1ad-a83f763ac070', 'Mike Williams'),
  ('a0000000-0000-0000-0000-000000000005', 'ad-chris-jones',         'dee28451-5d62-409e-a1ad-a83f763ac070', 'Chris Jones'),
  ('a0000000-0000-0000-0000-000000000006', 'ad-patrick-mahomes-ii',  'dee28451-5d62-409e-a1ad-a83f763ac070', 'Patrick Mahomes II'),
  ('a0000000-0000-0000-0000-000000000007', 'ad-nobody',              'dee28451-5d62-409e-a1ad-a83f763ac070', 'Nobody Known');
INSERT INTO player_name_aliases VALUES ('dee28451-5d62-409e-a1ad-a83f763ac070', 'patrick-mahomes', 'a0000000-0000-0000-0000-000000000006');

-- editions: the evidence. Josh Allen carries Bills editions (team breaks the
-- tie); Mike Williams carries no team, but 2022 games (season breaks it);
-- Chris Jones carries nothing usable (stays ambiguous).
INSERT INTO editions (player_id, team_name, game_date) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Arizona Cardinals',   '2024-10-06'),
  ('a0000000-0000-0000-0000-000000000002', 'Indianapolis Colts',  '2006-11-05'),
  ('a0000000-0000-0000-0000-000000000003', 'Buffalo Bills',       '2023-12-17'),
  ('a0000000-0000-0000-0000-000000000003', 'Jacksonville Jaguars','2022-10-02'),
  ('a0000000-0000-0000-0000-000000000004', NULL,                  '2022-11-13'),
  ('a0000000-0000-0000-0000-000000000005', NULL,                  NULL);

-- league rows (nflverse shape)
INSERT INTO player_identities (league, league_player_id, collection_id, name_slug, display_name, latest_team, rookie_season, last_season) VALUES
  ('nfl', '00-0039849', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'marvin-harrison-jr-', 'Marvin Harrison Jr.', 'ARI', 2024, 2026),
  ('nfl', '00-0007024', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'marvin-harrison',     'Marvin Harrison',     'IND', 1996, 2008),
  ('nfl', '00-0034857', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'josh-allen',          'Josh Allen',          'BUF', 2018, 2026),
  ('nfl', '00-0030833', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'josh-allen',          'Josh Allen',          'TB',  2011, 2016),
  ('nfl', '00-0033536', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'mike-williams',       'Mike Williams',       'LA',  2017, 2024),
  ('nfl', '00-0027986', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'mike-williams',       'Mike Williams',       'TB',  2010, 2014),
  ('nfl', '00-0033090', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'chris-jones',         'Chris Jones',         'KC',  2016, 2026),
  ('nfl', '00-0027889', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'chris-jones',         'Chris Jones',         'DAL', 2010, 2019),
  ('nfl', '00-0033873', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'patrick-mahomes',     'Patrick Mahomes',     'KC',  2017, 2026),
  ('nfl', '00-0099999', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'someone-else',        'Someone Else',        'KC',  2020, 2026);

-- ── run ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  r := match_player_identities('nfl');

  -- 1. unique names link by name — and each Harrison to HIS row
  PERFORM _assert_eq((SELECT player_id::text FROM player_identities WHERE league_player_id = '00-0039849'),
                     'a0000000-0000-0000-0000-000000000001', 'Marvin Harrison Jr. -> the Cardinals row');
  PERFORM _assert_eq((SELECT player_id::text FROM player_identities WHERE league_player_id = '00-0007024'),
                     'a0000000-0000-0000-0000-000000000002', 'Marvin Harrison -> the Colts row');
  PERFORM _assert_eq((SELECT matched_by FROM player_identities WHERE league_player_id = '00-0039849'), 'name', 'unique name matched_by');

  -- 2. two league rows, one player: the TEAM on the editions picks the Bills QB
  PERFORM _assert_eq((SELECT player_id::text FROM player_identities WHERE league_player_id = '00-0034857'),
                     'a0000000-0000-0000-0000-000000000003', 'Josh Allen -> the Bills QB (BUF editions)');
  PERFORM _assert_eq((SELECT matched_by FROM player_identities WHERE league_player_id = '00-0034857'), 'name+team', 'team tie-break matched_by');
  PERFORM _assert((SELECT player_id IS NULL FROM player_identities WHERE league_player_id = '00-0030833'), 'the 2016 Buccaneers centre stays unlinked');

  -- 3. no team evidence, season overlap picks the 2017–2024 Mike Williams (LA -> LAR normalised, no LAR edition, so not team)
  PERFORM _assert_eq((SELECT player_id::text FROM player_identities WHERE league_player_id = '00-0033536'),
                     'a0000000-0000-0000-0000-000000000004', 'Mike Williams -> the 2022-active row by season');
  PERFORM _assert_eq((SELECT matched_by FROM player_identities WHERE league_player_id = '00-0033536'), 'name+season', 'season tie-break matched_by');

  -- 4. nothing breaks the Chris Jones tie: both league rows stay NULL, and the
  --    player is COUNTED as ambiguous rather than guessed
  PERFORM _assert((SELECT count(*) = 0 FROM player_identities WHERE name_slug = 'chris-jones' AND player_id IS NOT NULL), 'Chris Jones is not guessed');
  PERFORM _assert_eq((r->>'players_ambiguous'), '1', 'players_ambiguous counts the unbroken tie');

  -- 5. the alias arm: the league spelling is an alias of the RPC row
  PERFORM _assert_eq((SELECT player_id::text FROM player_identities WHERE league_player_id = '00-0033873'),
                     'a0000000-0000-0000-0000-000000000006', 'Patrick Mahomes -> Patrick Mahomes II via alias');
  PERFORM _assert_eq((SELECT matched_by FROM player_identities WHERE league_player_id = '00-0033873'), 'alias', 'alias matched_by');

  -- 6. the report
  PERFORM _assert_eq((r->'matched'->>'name'), '2', 'matched.name');
  PERFORM _assert_eq((r->'matched'->>'name+team'), '1', 'matched.name+team');
  PERFORM _assert_eq((r->'matched'->>'name+season'), '1', 'matched.name+season');
  PERFORM _assert_eq((r->'matched'->>'alias'), '1', 'matched.alias');
  PERFORM _assert_eq((r->>'players_total'), '7', 'players_total');
  PERFORM _assert_eq((r->>'players_unmatched'), '2', 'players_unmatched: Chris Jones + Nobody Known');
  PERFORM _assert_eq((r->>'identities_total'), '10', 'identities_total');
  PERFORM _assert_eq((r->>'identities_unlinked'), '5', 'identities_unlinked: TB Allen, TB Williams, 2 Jones, Someone Else');

  -- 7. a second pass changes nothing and reports the same debt (idempotent)
  r := match_player_identities('nfl');
  PERFORM _assert_eq((r->>'matched'), '{}', 'second pass matches nothing new');
  PERFORM _assert_eq((r->>'players_ambiguous'), '1', 'ambiguity is re-reported, not cleared');
  PERFORM _assert_eq((SELECT count(*)::text FROM player_identities WHERE player_id IS NOT NULL), '5', 'five links, still');

  -- 8. an unknown league is refused, not silently empty
  BEGIN
    PERFORM match_player_identities('mlb');
    RAISE EXCEPTION 'ASSERT FAILED: unknown league accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%unknown league%' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;

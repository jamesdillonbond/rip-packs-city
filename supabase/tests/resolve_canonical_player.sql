-- DB invariant: public.resolve_canonical_player(uuid, text, text) — the canonical
-- resolve-or-create for a player keyed on (collection_id, name-slug). Introduced
-- 2026-08-01 for the Top Shot players dedupe: wallet-search had minted one player
-- row per playID (external_id 'flow:<playID>'), so a single athlete fragmented
-- across many rows; this function collapses them to one canonical row and every
-- new caller resolves-or-creates through it. A wrong result re-fragments players
-- or misattributes editions to the wrong player.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260926004254_audit_20260925_resolve_canonical_player_consults_the_player_identity_crosswalk.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- 2026-09-25: the slug folds accents through extensions.unaccent; Supabase
-- installs unaccent in the `extensions` schema — reproduce that so the
-- verbatim DDL resolves.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE collections (
  id   uuid PRIMARY KEY,
  slug text
);

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
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid
);

-- 2026-09-25: the alias table the resolver consults first (#137 a).
CREATE TABLE player_name_aliases (
  collection_id uuid NOT NULL,
  alias_slug    text NOT NULL,
  player_id     uuid NOT NULL,
  note          text,
  PRIMARY KEY (collection_id, alias_slug)
);

-- 2026-09-25 (batch 53): the league-id crosswalk the resolver consults first
-- (its tables and the two functions it calls, as fixture copies — each is
-- pinned in its own file).
CREATE TABLE teams_master (league text, team_name text, abbreviation text);
INSERT INTO teams_master VALUES ('NBA', 'Los Angeles Lakers', 'LAL'), ('NBA', 'Golden State Warriors', 'GSW'), ('NBA', 'Seattle SuperSonics', 'SEA');
CREATE TABLE player_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league text NOT NULL, league_player_id text NOT NULL, collection_id uuid NOT NULL,
  player_id uuid, matched_by text, matched_at timestamptz,
  name_slug text NOT NULL, display_name text NOT NULL,
  latest_team text, rookie_season int, last_season int,
  base_slug text GENERATED ALWAYS AS (regexp_replace(name_slug, '-(jr|sr|ii|iii|iv|v)-?$', '')) STORED
);
CREATE UNIQUE INDEX player_identities_player_id_uidx ON player_identities (player_id) WHERE player_id IS NOT NULL;
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

-- >>> BEGIN verbatim resolve_canonical_player (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_canonical_player(p_collection_id uuid, p_name text, p_team text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug      text;
  v_coll_slug text;
  v_id        uuid;
  v_r         jsonb;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(extensions.unaccent(p_name))), '[^a-z0-9]+', '-', 'g');
  IF v_slug = '' THEN
    RETURN NULL;
  END IF;

  -- 2026-09-25: a registered ALIAS (a second spelling of one person, e.g.
  -- "Stephen Curry" -> the "Steph Curry" row) resolves before the slug match,
  -- so the no-match arm cannot re-mint a merged duplicate.
  SELECT a.player_id INTO v_id
    FROM public.player_name_aliases a
   WHERE a.collection_id = p_collection_id
     AND a.alias_slug = v_slug;

  -- 2026-09-25 (batch 53): the league-id crosswalk decides before the slug.
  -- 'one' is the person (minted with the league's spelling when RPC has no
  -- row; the label aliased when no row owns its slug); 'ambiguous' and
  -- 'none' fall through to the slug match and the mint below, unchanged.
  IF v_id IS NULL THEN
    v_r := public.resolve_player_identity(p_collection_id, p_name, p_team, NULL);
    IF v_r->>'verdict' = 'one' THEN
      v_id := (v_r->>'player_id')::uuid;
      IF v_id IS NULL THEN
        SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;
        INSERT INTO public.players (external_id, collection_id, name, team, collection)
        VALUES (coalesce(v_coll_slug, 'unknown') || '-' || (v_r->>'name_slug'),
                p_collection_id, v_r->>'display_name', nullif(trim(coalesce(p_team, '')), ''),
                coalesce(v_coll_slug, 'unknown'))
        ON CONFLICT (external_id) DO NOTHING
        RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
          UPDATE public.player_identities
             SET player_id = v_id, matched_by = 'resolver', matched_at = now()
           WHERE id = (v_r->>'identity_id')::uuid AND player_id IS NULL;
        END IF;
      END IF;
      IF v_id IS NOT NULL AND v_slug <> (v_r->>'name_slug')
         AND NOT EXISTS (SELECT 1 FROM public.players p
                          WHERE p.collection_id = p_collection_id
                            AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug) THEN
        INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
        VALUES (p_collection_id, v_slug, v_id, 'resolver ' || to_char(now(), 'YYYY-MM-DD') || ': label for ' || (v_r->>'name_slug'))
        ON CONFLICT (collection_id, alias_slug) DO NOTHING;
      END IF;
    END IF;
  END IF;

  IF v_id IS NULL THEN
  SELECT p.id INTO v_id
    FROM public.players p
   WHERE p.collection_id = p_collection_id
     AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug
   ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$'  THEN 1
                 WHEN p.external_id LIKE 'flow:%' THEN 3
                 ELSE 2 END,
            (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
            p.id
   LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    IF p_team IS NOT NULL AND trim(p_team) <> '' THEN
      UPDATE public.players SET team = p_team, updated_at = now()
       WHERE id = v_id AND team IS NULL;
    END IF;
    RETURN v_id;
  END IF;

  SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;

  INSERT INTO public.players (external_id, collection_id, name, team, collection)
  VALUES (coalesce(v_coll_slug, 'unknown') || '-' || v_slug,
          p_collection_id, trim(p_name), nullif(trim(coalesce(p_team, '')), ''),
          coalesce(v_coll_slug, 'unknown'))
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT p.id INTO v_id
      FROM public.players p
     WHERE p.collection_id = p_collection_id
       AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug
     LIMIT 1;
  END IF;

  RETURN v_id;
END
$function$;
-- <<< END verbatim resolve_canonical_player <<<

-- Collection + fixture players. Two share the slug 'lebron-james': the canonical
-- numeric-external_id row (rank 1) and a 'flow:<playID>' fossil (rank 3).
INSERT INTO collections (id, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'nba_top_shot');

INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000001', '2738',       '11111111-1111-1111-1111-111111111111', 'LeBron James', NULL, 'nba_top_shot'),
  ('00000000-0000-0000-0000-000000000002', 'flow:2738',  '11111111-1111-1111-1111-111111111111', 'LeBron James', NULL, 'nba_top_shot');

-- Guard rails: null/blank name or null collection never mints a row.
SELECT _assert_eq(resolve_canonical_player('11111111-1111-1111-1111-111111111111', NULL)::text, NULL, 'NULL name → NULL');
SELECT _assert_eq(resolve_canonical_player('11111111-1111-1111-1111-111111111111', '   ')::text, NULL, 'blank name → NULL');
SELECT _assert_eq(resolve_canonical_player(NULL, 'LeBron James')::text, NULL, 'NULL collection → NULL');

-- Existing match: case-insensitive + whitespace-collapsing slug (leading/trailing
-- spaces are trimmed; interior runs collapse to one '-'), and the
-- numeric-external_id canonical row wins the tie-break over the flow:<playID>
-- fossil. NOTE: normalization does NOT strip edge dashes, so a trailing
-- punctuation char (e.g. 'James!') yields a trailing '-' and would MISS — the
-- probe here normalizes to exactly 'lebron-james'.
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', '  leBRON   JAMES  ')::text,
  '00000000-0000-0000-0000-000000000001',
  'slug-normalized match resolves to the numeric-id canonical row, not the flow: fossil');

-- No new row was minted for the existing match.
SELECT _assert_eq((SELECT count(*)::text FROM players), '2', 'existing match does not insert');

-- Team backfill: fills team only when it is currently NULL.
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000003', 'ext-team', '11111111-1111-1111-1111-111111111111', 'Team Guy', NULL, 'nba_top_shot');
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Team Guy', 'Trail Blazers');
SELECT _assert_eq((SELECT team FROM players WHERE external_id='ext-team'), 'Trail Blazers', 'team backfilled when NULL');
-- A second call with a different team must NOT overwrite the set value.
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Team Guy', 'Lakers');
SELECT _assert_eq((SELECT team FROM players WHERE external_id='ext-team'), 'Trail Blazers', 'team NOT overwritten once set');

-- Edition-count tie-break among two non-numeric, non-flow rows with the same slug:
-- the one with MORE editions wins.
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000004', 'ext-dup-a', '11111111-1111-1111-1111-111111111111', 'Dup Name', NULL, 'nba_top_shot'),
  ('00000000-0000-0000-0000-000000000005', 'ext-dup-b', '11111111-1111-1111-1111-111111111111', 'Dup Name', NULL, 'nba_top_shot');
INSERT INTO editions (player_id) VALUES
  ('00000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000005');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Dup Name')::text,
  '00000000-0000-0000-0000-000000000005',
  'edition-count tie-break: the row with more editions wins');

-- No match → inserts a new canonical row keyed '<collection-slug>-<name-slug>'.
-- (Insert in its own statement first: argument evaluation order within a single
-- call is unspecified, so a lookup subquery co-passed with the inserting call can
-- run BEFORE the insert.)
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Fresh  Rookie');
SELECT _assert(( (SELECT count(*) FROM players WHERE external_id='nba_top_shot-fresh-rookie') = 1 ),
  'no match → inserts one <collection-slug>-<name-slug> row');
SELECT _assert_eq((SELECT name FROM players WHERE external_id='nba_top_shot-fresh-rookie'), 'Fresh  Rookie',
  'new row stores the trimmed name');
-- With no team supplied the new row's team stays NULL (nullif(trim('')) → NULL).
SELECT _assert(( (SELECT team FROM players WHERE external_id='nba_top_shot-fresh-rookie') IS NULL ),
  'new row with no team → team NULL');
-- A second call is idempotent: it now resolves the just-created row (no new insert).
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Fresh  Rookie')::text,
  (SELECT id::text FROM players WHERE external_id='nba_top_shot-fresh-rookie'),
  'second call resolves to the same row (idempotent), mints no duplicate');

-- 2026-09-25: accents fold. An accented canonical row resolves from its plain
-- spelling and vice versa, and neither probe mints a second row (17 such
-- duplicates existed before 20260925101847).
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000006', '1629029', '11111111-1111-1111-1111-111111111111', 'Luka Dončić', NULL, 'nba_top_shot');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Luka Doncic')::text,
  '00000000-0000-0000-0000-000000000006',
  'plain spelling resolves the accented canonical row');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'LUKA DONČIĆ')::text,
  '00000000-0000-0000-0000-000000000006',
  'accented, upper-cased spelling resolves the same row');
SELECT _assert_eq((SELECT count(*)::text FROM players WHERE lower(extensions.unaccent(name)) = 'luka doncic'), '1',
  'neither accent-variant probe minted a second row');
-- A no-match accented name mints ONE row keyed on the UNACCENTED slug, and the
-- plain spelling then resolves it.
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Noémie Brochant');
SELECT _assert(( (SELECT count(*) FROM players WHERE external_id='nba_top_shot-noemie-brochant') = 1 ),
  'no match on an accented name → one row keyed on the unaccented slug');
SELECT _assert_eq((SELECT name FROM players WHERE external_id='nba_top_shot-noemie-brochant'), 'Noémie Brochant',
  'the stored name keeps its accents');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Noemie Brochant')::text,
  (SELECT id::text FROM players WHERE external_id='nba_top_shot-noemie-brochant'),
  'the plain spelling resolves the accented row it would once have duplicated');

-- 2026-09-25: a registered ALIAS resolves to its player BEFORE the slug match,
-- so a second NAME for one person (Stephen / Steph Curry) never mints a row.
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000007', '201939', '11111111-1111-1111-1111-111111111111', 'Steph Curry', NULL, 'nba_top_shot');
INSERT INTO player_name_aliases (collection_id, alias_slug, player_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'stephen-curry', '00000000-0000-0000-0000-000000000007');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Stephen Curry')::text,
  '00000000-0000-0000-0000-000000000007',
  'an alias spelling resolves to the aliased player');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', '  STEPHEN   curry ')::text,
  '00000000-0000-0000-0000-000000000007',
  'the alias is matched on the normalized slug');
SELECT _assert_eq((SELECT count(*)::text FROM players WHERE name ILIKE 'steph%curry'), '1',
  'the alias spelling minted no second row');
-- The alias beats even a slug match: a stray row carrying the alias spelling
-- does not capture new writes.
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000008', 'stray', '11111111-1111-1111-1111-111111111111', 'Stephen Curry', NULL, 'nba_top_shot');
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Stephen Curry')::text,
  '00000000-0000-0000-0000-000000000007',
  'the alias wins over a same-slug row');
-- Team backfill still applies on the alias path.
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Stephen Curry', 'Golden State Warriors');
SELECT _assert_eq((SELECT team FROM players WHERE id='00000000-0000-0000-0000-000000000007'), 'Golden State Warriors',
  'team backfilled through the alias path');

SELECT '✓ resolve_canonical_player invariants pass' AS result;

-- 2026-09-25 (batch 53): the crosswalk decides before the slug.
-- (a) a label that is a VARIANT of a feed-backed identity with a keyed row
--     resolves to that row, mints nothing, and aliases the label
INSERT INTO players (id, external_id, collection_id, name, team, collection) VALUES
  ('00000000-0000-0000-0000-000000000009', '1627780', '11111111-1111-1111-1111-111111111111', 'Gary Payton II', NULL, 'nba_top_shot');
INSERT INTO player_identities (id, league, league_player_id, collection_id, player_id, name_slug, display_name, latest_team, rookie_season, last_season) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'nba', '1627780', '11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000009', 'gary-payton-ii', 'Gary Payton II', 'GSW', 2016, 2026),
  ('b0000000-0000-0000-0000-000000000002', 'nba', '56',      '11111111-1111-1111-1111-111111111111', NULL,                                   'gary-payton',    'Gary Payton',    'SEA', 1990, 2007),
  -- a feed-backed rookie RPC has no row for yet
  ('b0000000-0000-0000-0000-000000000003', 'nba', '9999',    '11111111-1111-1111-1111-111111111111', NULL,                                   'newman-rookie-jr-', 'Newman Rookie Jr.', 'LAL', 2026, 2026);
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Gary Payton', 'Golden State Warriors')::text,
  '00000000-0000-0000-0000-000000000009',
  'a Warriors "Gary Payton" is Gary Payton II — decided by the crosswalk, not the exact slug');
SELECT _assert_eq((SELECT count(*)::text FROM players WHERE name ILIKE 'gary payton%'), '1', 'no row minted for the variant');
-- the label slug is NOT aliased: 'gary-payton' could be the father's URL (an owned slug is never aliased; here no row owns it, so it IS aliased)
SELECT _assert_eq((SELECT player_id::text FROM player_name_aliases WHERE alias_slug = 'gary-payton'), '00000000-0000-0000-0000-000000000009',
  'the label slug is aliased to the keyed row while no players row owns it');
-- (b) no evidence splits the two Paytons → ambiguous → the legacy path (exact slug, then a mint under the label)
DELETE FROM player_name_aliases WHERE alias_slug = 'gary-payton';
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Gary Payton', NULL);
SELECT _assert(( (SELECT count(*) FROM players WHERE external_id = 'nba_top_shot-gary-payton') = 1 ),
  'ambiguous → the legacy path mints under the label, as it always did');
-- (c) a feed-backed identity with no row: minted with the LEAGUE spelling, keyed, the label aliased
SELECT resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Newman Rookie', 'Los Angeles Lakers');
SELECT _assert_eq((SELECT name FROM players WHERE external_id = 'nba_top_shot-newman-rookie-jr-'), 'Newman Rookie Jr.',
  'minted with the league spelling, keyed on its slug');
SELECT _assert_eq((SELECT player_id::text FROM player_identities WHERE id = 'b0000000-0000-0000-0000-000000000003'),
  (SELECT id::text FROM players WHERE external_id = 'nba_top_shot-newman-rookie-jr-'), 'identity keyed by the resolver');
SELECT _assert_eq((SELECT matched_by FROM player_identities WHERE id = 'b0000000-0000-0000-0000-000000000003'), 'resolver', 'matched_by resolver');
SELECT _assert_eq((SELECT player_id::text FROM player_name_aliases WHERE alias_slug = 'newman-rookie'),
  (SELECT id::text FROM players WHERE external_id = 'nba_top_shot-newman-rookie-jr-'), 'the label aliased');
SELECT _assert(( (SELECT count(*) FROM players WHERE external_id = 'nba_top_shot-newman-rookie') = 0 ), 'no row under the label spelling');
-- (d) a second call resolves the minted row (alias first) and mints nothing
SELECT _assert_eq(
  resolve_canonical_player('11111111-1111-1111-1111-111111111111', 'Newman Rookie', 'Los Angeles Lakers')::text,
  (SELECT id::text FROM players WHERE external_id = 'nba_top_shot-newman-rookie-jr-'), 'idempotent');

ROLLBACK;

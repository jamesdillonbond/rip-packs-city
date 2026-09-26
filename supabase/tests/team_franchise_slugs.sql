-- DB invariant: the franchise helpers behind every team read (batch 62,
-- 2026-09-25) — team_franchise_slugs (every label of the franchise a slug
-- names), team_franchise_primary_name (its current name, else the most-minted
-- label) and team_historic_slugs (the labels the sitemap must not list). The
-- property: a franchise's historic era belongs to the franchise — "Raiders"
-- is Las Vegas + Oakland + Los Angeles under one page — while a label no
-- registry knows stays alone, a WNBA team never folds into the NBA team that
-- shares its abbreviation, and an accent-folded slug still finds its label.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260926033639_audit_20260925_a_franchises_historic_era_belongs_to_the_franchise.sql);
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
  ('NFL', 'Las Vegas Raiders', 'LV'), ('NFL', 'Washington Commanders', 'WAS'),
  ('NBA', 'Washington Wizards', 'WAS'), ('NBA', 'Charlotte Hornets', 'CHA'),
  ('WNBA', 'Washington Mystics', 'WAS'),
  ('LALIGA', 'Atlético de Madrid', 'ATM');
CREATE TABLE editions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, team_name text);

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
      ('nba', 'Charlotte Bobcats', 'CHA'),
      -- 2026-09-25 (batch 61): the historic labels Top Shot's moments carry
      ('nba', 'Washington Bullets', 'WAS'),       ('nba', 'Los Angeles Clippers', 'LAC'),
      ('nba', 'San Diego Clippers', 'LAC'),       ('nba', 'Buffalo Braves', 'LAC'),
      ('nba', 'St. Louis Hawks', 'ATL'),          ('nba', 'New Orleans/Oklahoma City Hornets', 'NOP'),
      ('nba', 'Kansas City-Omaha Kings', 'SAC'),  ('nba', 'Kansas City Kings', 'SAC'),
      ('wnba', 'San Antonio Stars', 'LVA'),       ('wnba', 'San Antonio Silver Stars', 'LVA'),
      ('wnba', 'Utah Starzz', 'LVA'),             ('wnba', 'Detroit Shock', 'DAL'),
      ('wnba', 'Tulsa Shock', 'DAL'),             ('wnba', 'Orlando Miracle', 'CON')
    ) v(league, team_name, abbr)
   WHERE v.league = p_league
$function$;

-- >>> BEGIN verbatim team_franchise_slugs (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.team_franchise_slugs(p_collection_id uuid, p_team_slug text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- The site slugs of every label of the franchise p_team_slug names. Keyed from
-- the REGISTRIES only (league_team_abbr — historic names, the WNBA arm — else
-- teams_master), never from editions: the callers put the result in an index
-- condition (`slug_expr = ANY (…)`), so this must cost milliseconds, and a
-- label no registry knows is its own franchise (the slug comes back alone).
-- The list may name a label no edition carries (Tennessee Oilers); harmless in
-- a predicate. Accent-tolerant on input (atletico-de-madrid finds Atlético).
DECLARE
  v_coll  text;
  v_maps  text[];
  v_tm    text;
  v_out   text[];
BEGIN
  IF p_collection_id IS NULL OR p_team_slug IS NULL OR p_team_slug = '' THEN
    RETURN ARRAY[COALESCE(p_team_slug, '')];
  END IF;
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_maps := CASE v_coll WHEN 'nfl_all_day' THEN ARRAY['nfl'] WHEN 'nba_top_shot' THEN ARRAY['nba', 'wnba'] END;
  v_tm   := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;

  WITH names AS (
    -- the league map(s), first map wins for a name in both (nba before wnba)
    SELECT a.team_name, 'map:' || m.lg || ':' || a.abbr AS fkey, m.ord::int AS ord
      FROM unnest(COALESCE(v_maps, '{}'::text[])) WITH ORDINALITY AS m(lg, ord)
      CROSS JOIN LATERAL public.league_team_abbr(m.lg) a
    UNION ALL
    -- teams_master, namespaced by league (the Mystics' WAS must not fold into the Wizards' WAS)
    SELECT t.team_name, 'tm:' || t.league::text || ':' || t.abbreviation, 100
      FROM public.teams_master t
     WHERE t.league::text = ANY (ARRAY[v_tm, 'WNBA'])
  ),
  keyed AS (
    SELECT DISTINCT ON (n.team_name) n.team_name, n.fkey,
           regexp_replace(lower(trim(n.team_name)), '[^a-z0-9]+', '-', 'g') AS slug,
           regexp_replace(lower(trim(extensions.unaccent(n.team_name))), '[^a-z0-9]+', '-', 'g') AS uslug
      FROM names n
     ORDER BY n.team_name, n.ord
  ),
  hit AS (
    SELECT k.fkey FROM keyed k
     WHERE k.slug = p_team_slug OR k.uslug = p_team_slug
     ORDER BY (k.slug = p_team_slug) DESC LIMIT 1
  )
  SELECT array_agg(DISTINCT k.slug) INTO v_out
    FROM keyed k JOIN hit h ON h.fkey = k.fkey;
  RETURN COALESCE(v_out, ARRAY[p_team_slug]);
END
$function$;
-- <<< END verbatim team_franchise_slugs <<<

-- >>> BEGIN verbatim team_franchise_primary_name (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.team_franchise_primary_name(p_collection_id uuid, p_team_slug text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- The franchise's CURRENT name: a teams_master row of the collection's league
-- (WNBA included for Top Shot) whose slug is in the franchise, else the
-- most-minted label the collection's editions carry, else NULL (no such team).
-- plpgsql on purpose: a SQL body inlines into its caller and the planner then
-- re-evaluates team_franchise_slugs per scanned row (a 57014 on first apply).
DECLARE
  v_slugs text[];
  v_coll  text;
  v_tm    text;
  v_name  text;
BEGIN
  v_slugs := public.team_franchise_slugs(p_collection_id, p_team_slug);
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_tm := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;

  SELECT t.team_name INTO v_name
    FROM public.teams_master t
   WHERE t.league::text = ANY (ARRAY[v_tm, 'WNBA'])
     AND regexp_replace(lower(trim(t.team_name)), '[^a-z0-9]+', '-', 'g') = ANY (v_slugs)
   ORDER BY t.team_name
   LIMIT 1;
  IF v_name IS NOT NULL THEN RETURN v_name; END IF;

  SELECT e.team_name INTO v_name
    FROM public.editions e
   WHERE e.collection_id = p_collection_id AND e.team_name IS NOT NULL
     AND regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g') = ANY (v_slugs)
   GROUP BY e.team_name
   ORDER BY count(*) DESC, e.team_name
   LIMIT 1;
  RETURN v_name;
END
$function$;
-- <<< END verbatim team_franchise_primary_name <<<

-- >>> BEGIN verbatim team_historic_slugs (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.team_historic_slugs(p_collection_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Every team label of the collection whose franchise has a DIFFERENT primary
-- name: the slugs the sitemap must not list (they 308 to the primary page).
-- One primary_name call per distinct label (tens per collection).
DECLARE
  r      record;
  v_out  text[] := '{}';
BEGIN
  FOR r IN
    SELECT DISTINCT e.team_name,
           regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g') AS slug
      FROM public.editions e
     WHERE e.collection_id = p_collection_id AND e.team_name IS NOT NULL AND trim(e.team_name) <> ''
     ORDER BY 2
  LOOP
    IF public.team_franchise_primary_name(p_collection_id, r.slug) IS DISTINCT FROM r.team_name THEN
      v_out := v_out || r.slug;
    END IF;
  END LOOP;
  RETURN v_out;
END
$function$;
-- <<< END verbatim team_historic_slugs <<<

INSERT INTO editions (collection_id, team_name)
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'Las Vegas Raiders' FROM generate_series(1, 114) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Oakland Raiders' FROM generate_series(1, 18) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Los Angeles Raiders' FROM generate_series(1, 8) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Washington Commanders' FROM generate_series(1, 105) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Washington Football Team' FROM generate_series(1, 50) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Team AFC' FROM generate_series(1, 3) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Houston Oilers' FROM generate_series(1, 9) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Washington Wizards' FROM generate_series(1, 322) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Washington Bullets' FROM generate_series(1, 16) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Washington Mystics' FROM generate_series(1, 176) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Charlotte Hornets' FROM generate_series(1, 361) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Charlotte Bobcats' FROM generate_series(1, 17) UNION ALL
  SELECT '11111111-1111-1111-1111-111111111111', 'Raiders FC' FROM generate_series(1, 2);
-- LaLiga: an accented label, resolved by its accent-folded slug
INSERT INTO collections VALUES ('22222222-2222-2222-2222-222222222222', 'laliga_golazos');
INSERT INTO editions (collection_id, team_name) SELECT '22222222-2222-2222-2222-222222222222', 'Atlético de Madrid' FROM generate_series(1, 5);

DO $$
DECLARE ad uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'; ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd'; s text[];
BEGIN
  -- 1. THE case: the current label names the whole franchise; so does a historic one
  s := team_franchise_slugs(ad, 'las-vegas-raiders');
  PERFORM _assert_eq(array_to_string((SELECT array_agg(x ORDER BY x) FROM unnest(s) x), ','), 'las-vegas-raiders,los-angeles-raiders,oakland-raiders', 'Raiders: three labels, one franchise');
  PERFORM _assert_eq(array_to_string((SELECT array_agg(x ORDER BY x) FROM unnest(team_franchise_slugs(ad, 'oakland-raiders')) x), ','), 'las-vegas-raiders,los-angeles-raiders,oakland-raiders', 'from a historic label too');
  PERFORM _assert_eq(team_franchise_primary_name(ad, 'oakland-raiders'), 'Las Vegas Raiders', 'primary = the current teams_master name');
  PERFORM _assert_eq(team_franchise_primary_name(ad, 'las-vegas-raiders'), 'Las Vegas Raiders', 'and for the current label itself');

  -- 2. a franchise whose current name is in the map only through the historic list still resolves
  PERFORM _assert_eq(team_franchise_primary_name(ad, 'washington-football-team'), 'Washington Commanders', 'Football Team -> Commanders');

  -- 3. the WNBA WAS never folds into the NBA WAS; the Bullets do
  s := team_franchise_slugs(ts, 'washington-wizards');
  PERFORM _assert_eq(array_to_string((SELECT array_agg(x ORDER BY x) FROM unnest(s) x), ','), 'washington-bullets,washington-wizards', 'Wizards + Bullets, no Mystics');
  PERFORM _assert_eq(array_to_string(team_franchise_slugs(ts, 'washington-mystics'), ','), 'washington-mystics', 'the Mystics alone');
  PERFORM _assert_eq(team_franchise_primary_name(ts, 'washington-bullets'), 'Washington Wizards', 'Bullets -> Wizards');

  -- 4. a label no registry knows is its own franchise; a defunct franchise with no current team keeps its most-minted label
  PERFORM _assert_eq(array_to_string(team_franchise_slugs(ad, 'team-afc'), ','), 'team-afc', 'unknown label alone');
  PERFORM _assert_eq(team_franchise_primary_name(ad, 'team-afc'), 'Team AFC', 'its own primary');
  -- Houston Oilers map to TEN, but no Titans row exists in this fixture: the franchise is the Oilers alone, primary = its only label
  PERFORM _assert_eq(team_franchise_primary_name(ad, 'houston-oilers'), 'Houston Oilers', 'no current row -> the most-minted label');

  -- 5. an unknown slug comes back as itself (the caller's own no-match path stays a no-match)
  PERFORM _assert_eq(array_to_string(team_franchise_slugs(ad, 'no-such-team'), ','), 'no-such-team', 'unknown slug -> itself');
  PERFORM _assert(team_franchise_primary_name(ad, 'no-such-team') IS NULL, 'unknown slug -> no primary');

  -- 6. an accent-folded slug finds the accented label (LaLiga)
  PERFORM _assert_eq(array_to_string(team_franchise_slugs('22222222-2222-2222-2222-222222222222', 'atletico-de-madrid'), ','), 'atl-tico-de-madrid', 'unaccented input -> the site slug of the accented label');

  -- 7. the historic slugs of a collection: exactly the non-primary labels
  PERFORM _assert_eq(array_to_string(team_historic_slugs(ad), ','), 'los-angeles-raiders,oakland-raiders,washington-football-team', 'All Day historic labels');
  PERFORM _assert_eq(array_to_string(team_historic_slugs(ts), ','), 'charlotte-bobcats,washington-bullets', 'Top Shot historic labels');
  PERFORM _assert_eq(array_to_string(team_historic_slugs('11111111-1111-1111-1111-111111111111'), ','), '', 'UFC: none');
END $$;

ROLLBACK;

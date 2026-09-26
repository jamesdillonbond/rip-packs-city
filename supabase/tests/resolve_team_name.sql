-- DB invariant: public.resolve_team_name(uuid, text) — the concierge's view
-- of a TEAM name (batch 61, 2026-09-25). The property: the team labels a
-- collection's moments carry are grouped into FRANCHISES through the league
-- map (teams_master + historic names), so "Raiders" is ONE franchise whose
-- primary name is Las Vegas with Oakland and Los Angeles as historic labels
-- (edition counts kept); a label no registry knows stays its own franchise
-- (a WNBA team's WAS never folds into the Wizards' WAS); several franchises
-- are 'ambiguous' unless one primary name was typed exactly; an unknown label
-- is 'none'.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260926033639_audit_20260925_a_franchises_historic_era_belongs_to_the_franchise.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);
INSERT INTO collections VALUES ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
                               ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'),
                               ('11111111-1111-1111-1111-111111111111', 'ufc_strike');
CREATE TABLE teams_master (league text, team_name text, abbreviation text);
INSERT INTO teams_master VALUES
  ('NFL', 'Las Vegas Raiders', 'LV'), ('NFL', 'Washington Commanders', 'WAS'), ('NFL', 'Los Angeles Rams', 'LAR'),
  ('NBA', 'Washington Wizards', 'WAS'), ('NBA', 'Charlotte Hornets', 'CHA'), ('NBA', 'New Orleans Pelicans', 'NOP'),
  ('WNBA', 'Washington Mystics', 'WAS');
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

-- >>> BEGIN verbatim resolve_team_name (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_team_name(p_collection_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll   text;
  v_maps   text[]; -- league_team_abbr arguments (nfl | nba + wnba), NULL when the collection has no map
  v_tm     text;   -- teams_master.league
  v_q      text;
  v_fr     jsonb;
  v_n      int;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'reason', 'empty name');
  END IF;
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_maps := CASE v_coll WHEN 'nfl_all_day' THEN ARRAY['nfl'] WHEN 'nba_top_shot' THEN ARRAY['nba', 'wnba'] END;
  v_tm     := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;
  v_q := '%' || trim(p_name) || '%';

  WITH labels AS (
    -- every team label of the collection, so a matched franchise expands to ALL its names
    SELECT e.team_name, count(*)::int AS editions
      FROM public.editions e
     WHERE e.collection_id = p_collection_id
       AND e.team_name IS NOT NULL AND trim(e.team_name) <> ''
     GROUP BY e.team_name
  ),
  keyed AS (
    SELECT l.team_name, l.editions,
           -- the franchise key: the league map's abbreviation (historic names
           -- included), else teams_master's namespaced by league (the Mystics'
           -- WAS must not fold into the Wizards' WAS), else the label itself
           COALESCE(
             (SELECT 'map:' || m.lg || ':' || a.abbr
                FROM unnest(COALESCE(v_maps, '{}'::text[])) WITH ORDINALITY AS m(lg, ord)
                CROSS JOIN LATERAL public.league_team_abbr(m.lg) a
               WHERE a.team_name = l.team_name ORDER BY m.ord LIMIT 1),
             (SELECT 'tm:' || t.league::text || ':' || t.abbreviation FROM public.teams_master t
               WHERE t.team_name = l.team_name AND t.league::text = ANY (ARRAY[v_tm, 'WNBA']) LIMIT 1),
             'label:' || l.team_name) AS fkey,
           EXISTS (SELECT 1 FROM public.teams_master t
                    WHERE t.team_name = l.team_name AND t.league::text = ANY (ARRAY[v_tm, 'WNBA'])) AS is_current,
           (l.team_name ILIKE v_q) AS matched
      FROM labels l
  ),
  fr AS (
    SELECT k.fkey,
           (SELECT k2.team_name FROM keyed k2 WHERE k2.fkey = k.fkey AND k2.is_current ORDER BY k2.editions DESC LIMIT 1) AS current_name,
           sum(k.editions)::int AS total_editions,
           jsonb_agg(jsonb_build_object('team_name', k.team_name, 'editions', k.editions, 'current', k.is_current)
                     ORDER BY k.is_current DESC, k.editions DESC) AS names
      FROM keyed k
     WHERE k.fkey IN (SELECT m.fkey FROM keyed m WHERE m.matched)
     GROUP BY k.fkey
  )
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object(
           'franchise', regexp_replace(f.fkey, '^(map:[a-z]+|tm:[A-Z]+|label):', ''),
           'current_name', f.current_name,
           -- the name to query the per-team RPCs with: the current one, else the most-minted label
           'primary_name', COALESCE(f.current_name, (f.names->0->>'team_name')),
           'total_editions', f.total_editions,
           'names', f.names,
           'historic_names', (SELECT COALESCE(jsonb_agg(n) , '[]'::jsonb) FROM jsonb_array_elements(f.names) n
                               WHERE n->>'team_name' IS DISTINCT FROM COALESCE(f.current_name, (f.names->0->>'team_name')))
         ) ORDER BY f.total_editions DESC), '[]'::jsonb)
    INTO v_n, v_fr
    FROM fr f;

  IF v_n = 0 THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'note', 'No team label in this collection matches. Do not substitute another team.');
  END IF;
  IF v_n = 1 THEN
    RETURN jsonb_build_object('status', 'one', 'query', p_name)
           || (v_fr->0)
           || CASE WHEN jsonb_array_length(v_fr->0->'historic_names') > 0
                   THEN jsonb_build_object('note', 'This franchise has minted under more than one name; the team reads cover EVERY era (historic labels included) — the historic_names list says which labels and how many editions each carries.')
                   ELSE '{}'::jsonb END;
  END IF;
  -- an exact label match among several franchises decides ("Hornets" → Charlotte, not New Orleans, only when typed exactly)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fr) f WHERE lower(f->>'primary_name') = lower(trim(p_name))) THEN
    SELECT f INTO v_fr FROM jsonb_array_elements(v_fr) f WHERE lower(f->>'primary_name') = lower(trim(p_name)) LIMIT 1;
    RETURN jsonb_build_object('status', 'one', 'query', p_name) || v_fr;
  END IF;
  RETURN jsonb_build_object('status', 'ambiguous', 'query', p_name, 'franchises', v_fr,
                            'note', 'Several franchises match — ask which one, then call again with its primary_name.');
END
$function$;
-- <<< END verbatim resolve_team_name <<<

INSERT INTO editions (collection_id, team_name)
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'Las Vegas Raiders' FROM generate_series(1, 114) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Oakland Raiders' FROM generate_series(1, 18) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Los Angeles Raiders' FROM generate_series(1, 8) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Washington Commanders' FROM generate_series(1, 105) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Washington Football Team' FROM generate_series(1, 50) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Los Angeles Rams' FROM generate_series(1, 253) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'St. Louis Rams' FROM generate_series(1, 25) UNION ALL
  SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Team AFC' FROM generate_series(1, 3) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Washington Wizards' FROM generate_series(1, 322) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Washington Bullets' FROM generate_series(1, 16) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Washington Mystics' FROM generate_series(1, 176) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Charlotte Hornets' FROM generate_series(1, 361) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Charlotte Bobcats' FROM generate_series(1, 17) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'New Orleans Hornets' FROM generate_series(1, 9) UNION ALL
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'New Orleans Pelicans' FROM generate_series(1, 350) UNION ALL
  SELECT '11111111-1111-1111-1111-111111111111', 'Raiders FC' FROM generate_series(1, 2);

DO $$
DECLARE r jsonb; ad uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'; ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  -- 1. THE case: three labels, one franchise, the current name primary, historic labels with counts
  r := resolve_team_name(ad, 'Raiders');
  PERFORM _assert_eq(r->>'status', 'one', 'Raiders: one franchise');
  PERFORM _assert_eq(r->>'primary_name', 'Las Vegas Raiders', 'the current name is primary');
  PERFORM _assert_eq(r->>'franchise', 'LV', 'keyed on the league map');
  PERFORM _assert_eq(r->>'total_editions', '140', 'editions summed over every label');
  PERFORM _assert_eq(jsonb_array_length(r->'historic_names')::text, '2', 'two historic labels');
  PERFORM _assert_eq(r->'historic_names'->0->>'team_name', 'Oakland Raiders', 'commonest historic label first');
  PERFORM _assert_eq(r->'historic_names'->0->>'editions', '18', 'with its count');
  PERFORM _assert((r->>'note') LIKE '%EVERY era%', 'the answer says the reads cover every era (batch 62)');

  -- 2. a historic label typed directly still resolves to the FRANCHISE
  r := resolve_team_name(ad, 'Oakland');
  PERFORM _assert_eq(r->>'primary_name', 'Las Vegas Raiders', 'Oakland -> the Raiders franchise');

  -- 3. All Day "Washington": one franchise (Commanders + Football Team)
  r := resolve_team_name(ad, 'Washington');
  PERFORM _assert_eq(r->>'status', 'one', 'Washington (AD): one');
  PERFORM _assert_eq(r->>'primary_name', 'Washington Commanders', 'the Commanders');
  PERFORM _assert_eq(r->'historic_names'->0->>'team_name', 'Washington Football Team', 'with the Football Team');

  -- 4. Top Shot "Washington": the Wizards/Bullets AND the Mystics — the WNBA WAS never folds into the NBA WAS
  r := resolve_team_name(ts, 'Washington');
  PERFORM _assert_eq(r->>'status', 'ambiguous', 'Washington (TS): ambiguous');
  PERFORM _assert_eq(jsonb_array_length(r->'franchises')::text, '2', 'two franchises');
  PERFORM _assert_eq(r->'franchises'->0->>'primary_name', 'Washington Wizards', 'the bigger first');
  PERFORM _assert_eq(r->'franchises'->0->>'total_editions', '338', 'Wizards + Bullets');
  PERFORM _assert_eq(r->'franchises'->1->>'primary_name', 'Washington Mystics', 'the Mystics on their own');

  -- 5. "Hornets": Charlotte (with the Bobcats) and New Orleans (with the Pelicans) — ambiguous; the exact primary name decides
  r := resolve_team_name(ts, 'Hornets');
  PERFORM _assert_eq(r->>'status', 'ambiguous', 'Hornets: ambiguous');
  r := resolve_team_name(ts, 'Charlotte Hornets');
  PERFORM _assert_eq(r->>'status', 'one', 'Charlotte Hornets: one');
  PERFORM _assert_eq(r->'historic_names'->0->>'team_name', 'Charlotte Bobcats', 'expanded to the Bobcats even though "Charlotte Hornets" does not match that label');
  -- a historic label of another franchise: New Orleans Hornets -> the Pelicans
  r := resolve_team_name(ts, 'New Orleans Hornets');
  PERFORM _assert_eq(r->>'primary_name', 'New Orleans Pelicans', 'New Orleans Hornets -> the Pelicans franchise');

  -- 6. a label no registry knows is its own franchise; a collection with no map still resolves by label
  r := resolve_team_name(ad, 'Team AFC');
  PERFORM _assert_eq(r->>'status', 'one', 'Team AFC: one');
  PERFORM _assert_eq(r->>'primary_name', 'Team AFC', 'itself');
  PERFORM _assert((r->>'current_name') IS NULL, 'no current name — not a franchise the registry knows');
  r := resolve_team_name('11111111-1111-1111-1111-111111111111', 'Raiders');
  PERFORM _assert_eq(r->>'primary_name', 'Raiders FC', 'UFC label by itself');

  -- 7. nothing invented
  r := resolve_team_name(ts, 'Zzyzx');
  PERFORM _assert_eq(r->>'status', 'none', 'unknown: none');
END $$;

ROLLBACK;

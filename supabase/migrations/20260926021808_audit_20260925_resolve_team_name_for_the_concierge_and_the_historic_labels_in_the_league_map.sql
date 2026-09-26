-- 2026-09-25 (PT) — the concierge's view of a TEAM name: the same class as the
-- player work (batches 55–60), for franchises. editions.team_name carries the
-- name the moment was minted under, so one franchise is several labels —
-- "Raiders" is Las Vegas (114), Oakland (18) and Los Angeles (8); "Washington"
-- on All Day is the Commanders (105) and the Football Team (50); Top Shot has
-- Seattle SuperSonics beside Oklahoma City Thunder, New Jersey beside Brooklyn,
-- Charlotte Bobcats beside the Hornets, New Orleans Hornets beside the
-- Pelicans, Washington Bullets beside the Wizards. The concierge's team
-- resolver saw three "Raiders" and asked the collector which one.
--
-- resolve_team_name(collection, name) → jsonb: the matching team labels of the
-- collection grouped into FRANCHISES through league_team_abbr (teams_master +
-- its historic names; WNBA and LaLiga through teams_master directly), each
-- with its CURRENT name (the teams_master row) and every historic label with
-- its edition count. 'one' when the labels are one franchise (or one lone
-- label), 'ambiguous' with the franchises otherwise, 'none'. A label no
-- registry knows is its own franchise (an exhibition roster, a WNBA team the
-- NBA map lacks) — never folded into another. service_role only.
--
-- Revert: DROP FUNCTION public.resolve_team_name(uuid, text); re-apply league_team_abbr from 20260925232127.

-- The league map gains the historic names Top Shot's moments actually carry
-- (measured 2026-09-25: Washington Bullets 16, "Los Angeles Clippers" 53 —
-- teams_master spells it LA Clippers — St. Louis Hawks, the 2005–07
-- "New Orleans/Oklahoma City Hornets", Kansas City-Omaha Kings, Buffalo
-- Braves) and a WNBA arm's historic names (San Antonio Stars / Silver Stars
-- → the Aces, Detroit / Tulsa Shock → the Wings). Full-body write from the
-- live prosrc (md5 36227d08… re-read 7:20 PM PT, equal to 20260925232127).
-- Defunct franchises (Houston Comets, Sacramento Monarchs) stay their own
-- label — there is no current team to fold them into.
-- anon-exec: intentional — full-body write of league_team_abbr; its ACL is unchanged by CREATE OR REPLACE
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

-- anon-exec: intentional — resolve_team_name is service_role only (REVOKE/GRANT below); the concierge route calls it
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
                   THEN jsonb_build_object('note', 'This franchise has minted under more than one name; the per-team reads below are for the primary name only — say so, and call again with a historic name to include those moments.')
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

REVOKE ALL ON FUNCTION public.resolve_team_name(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_team_name(uuid, text) TO service_role;

-- Post-conditions on the live catalog
DO $$
DECLARE r jsonb;
BEGIN
  r := public.resolve_team_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Raiders');
  IF r->>'status' <> 'one' OR r->>'primary_name' <> 'Las Vegas Raiders' OR jsonb_array_length(r->'historic_names') <> 2 THEN
    RAISE EXCEPTION 'resolve_team_name: Raiders -> %', r; END IF;
  r := public.resolve_team_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Washington');
  IF r->>'status' <> 'one' OR r->>'primary_name' <> 'Washington Commanders' THEN
    RAISE EXCEPTION 'resolve_team_name: Washington (All Day) -> %', r; END IF;
  -- Top Shot "Washington": the Wizards/Bullets franchise AND the Mystics (WNBA) — two franchises, ambiguous
  r := public.resolve_team_name('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Washington');
  IF r->>'status' <> 'ambiguous' OR jsonb_array_length(r->'franchises') <> 2 THEN
    RAISE EXCEPTION 'resolve_team_name: Washington (Top Shot) -> %', r; END IF;
  r := public.resolve_team_name('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Hornets');
  IF r->>'status' <> 'ambiguous' THEN RAISE EXCEPTION 'resolve_team_name: Hornets -> %', r; END IF;
  r := public.resolve_team_name('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Charlotte Hornets');
  IF r->>'status' <> 'one' OR r->>'primary_name' <> 'Charlotte Hornets' OR jsonb_array_length(r->'historic_names') <> 1 THEN
    RAISE EXCEPTION 'resolve_team_name: Charlotte Hornets -> %', r; END IF;
END $$;

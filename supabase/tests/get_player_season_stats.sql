-- DB invariant: public.get_player_season_stats(uuid, int) (+ the writer it
-- reads, upsert_player_season_stats) — the player page's stats read, added
-- 2026-09-25 (batch 47, the ESPN-fed stats feed). The property: THREE states,
-- never two. A player with no identity, or an identity the feed cannot key
-- (no espn_id), reads NULL — "no feed for this player"; an identity with an
-- espn_id and no rows reads rows: [] — "no stats yet"; rows read newest
-- season first, bounded to the latest N seasons. The writer stamps
-- stats_refreshed_at on every touched identity, including one ESPN answered
-- with zero categories, so it leaves the front of the queue.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925235606_audit_20260925_player_season_stats_keyed_by_team_too.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE player_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league text NOT NULL, espn_id text, display_name text NOT NULL, player_id uuid,
  refreshed_at timestamptz NOT NULL DEFAULT now(), stats_refreshed_at timestamptz, espn_id_matched_by text
);
CREATE TABLE player_season_stats (
  league text NOT NULL, espn_id text NOT NULL, season int NOT NULL, season_type int NOT NULL DEFAULT 2,
  category text NOT NULL, display_name text, team_slug text NOT NULL DEFAULT '', is_total boolean NOT NULL DEFAULT false,
  labels text[] NOT NULL, names text[] NOT NULL, "values" text[] NOT NULL,
  source text NOT NULL DEFAULT 'espn', refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league, espn_id, season, season_type, category, team_slug),
  CHECK (array_length(labels, 1) = array_length("values", 1))
);

-- the writer (its own pin would be this same file; kept as a fixture copy)
CREATE OR REPLACE FUNCTION public.upsert_player_season_stats(p_league text, p_rows jsonb, p_touched text[] DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  IF p_league NOT IN ('nba', 'nfl') THEN
    RAISE EXCEPTION 'upsert_player_season_stats: unknown league %', p_league;
  END IF;
  WITH r AS (
    SELECT DISTINCT ON (x.espn_id, x.season, COALESCE(x.season_type, 2), x.category, COALESCE(nullif(trim(x.team_slug), ''), ''))
           x.*
      FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
             AS x(espn_id text, season int, season_type int, category text, display_name text,
                  team_slug text, is_total boolean, labels text[], names text[], "values" text[])
     ORDER BY x.espn_id, x.season, COALESCE(x.season_type, 2), x.category, COALESCE(nullif(trim(x.team_slug), ''), '')
  ),
  ins AS (
    INSERT INTO public.player_season_stats
      (league, espn_id, season, season_type, category, display_name, team_slug, is_total, labels, names, "values", source, refreshed_at)
    SELECT p_league, trim(r.espn_id), r.season, COALESCE(r.season_type, 2), trim(r.category),
           nullif(trim(r.display_name), ''), COALESCE(nullif(trim(r.team_slug), ''), ''), COALESCE(r.is_total, false),
           r.labels, r.names, r."values", 'espn', now()
      FROM r
     WHERE r.espn_id IS NOT NULL AND trim(r.espn_id) <> ''
       AND r.season IS NOT NULL AND r.category IS NOT NULL AND trim(r.category) <> ''
       AND r.labels IS NOT NULL AND r.names IS NOT NULL AND r."values" IS NOT NULL
       AND array_length(r.labels, 1) = array_length(r."values", 1)
    ON CONFLICT (league, espn_id, season, season_type, category, team_slug) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      is_total     = EXCLUDED.is_total,
      labels       = EXCLUDED.labels,
      names        = EXCLUDED.names,
      "values"     = EXCLUDED."values",
      source       = EXCLUDED.source,
      refreshed_at = now()
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM ins;

  IF p_touched IS NOT NULL AND array_length(p_touched, 1) > 0 THEN
    UPDATE public.player_identities i
       SET stats_refreshed_at = now()
     WHERE i.league = p_league AND i.espn_id = ANY (p_touched);
  END IF;
  RETURN v_n;
END
$function$;

-- >>> BEGIN verbatim get_player_season_stats (keep byte-identical to the migration) >>>
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
  SELECT i.id, i.league, i.espn_id, i.display_name, i.stats_refreshed_at
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
    'display_name', v_ident.display_name,
    'stats_refreshed_at', v_ident.stats_refreshed_at,
    'rows_refreshed_at', v_refreshed,
    'rows', v_rows
  );
END
$function$;
-- <<< END verbatim get_player_season_stats <<<

INSERT INTO player_identities (id, league, espn_id, display_name, player_id) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'nfl', '3139477', 'Patrick Mahomes', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002', 'nba', NULL,      'Gary Payton',     'a0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000003', 'nfl', '999',     'Rookie Nobody',   'a0000000-0000-0000-0000-000000000003');

DO $$
DECLARE r jsonb; n int;
BEGIN
  -- 1. no identity at all -> NULL
  PERFORM _assert(get_player_season_stats('a0000000-0000-0000-0000-000000000009', 3) IS NULL, 'unknown player -> NULL');
  -- 2. identity without an espn_id -> NULL (no feed), not []
  PERFORM _assert(get_player_season_stats('a0000000-0000-0000-0000-000000000002', 3) IS NULL, 'no espn_id -> NULL');
  -- 3. keyed identity, no rows yet -> rows [] and no refresh stamp
  r := get_player_season_stats('a0000000-0000-0000-0000-000000000003', 3);
  PERFORM _assert(r IS NOT NULL, 'keyed identity is not NULL');
  PERFORM _assert_eq(r->>'rows', '[]', 'no stats yet -> rows []');
  PERFORM _assert((r->>'rows_refreshed_at') IS NULL, 'no rows -> no rows_refreshed_at');

  -- 4. the writer: four seasons of passing, one of rushing; a malformed row
  --    (labels/values length mismatch) is dropped, not stored
  n := upsert_player_season_stats('nfl', jsonb_build_array(
    jsonb_build_object('espn_id','3139477','season',2022,'season_type',2,'category','passing','display_name','Passing','team_slug','kansas-city-chiefs','labels',array['GP','YDS'],'names',array['gamesPlayed','passingYards'],'values',array['17','5,250']),
    jsonb_build_object('espn_id','3139477','season',2023,'season_type',2,'category','passing','display_name','Passing','team_slug','kansas-city-chiefs','labels',array['GP','YDS'],'names',array['gamesPlayed','passingYards'],'values',array['16','4,183']),
    jsonb_build_object('espn_id','3139477','season',2024,'season_type',2,'category','passing','display_name','Passing','team_slug','kansas-city-chiefs','labels',array['GP','YDS'],'names',array['gamesPlayed','passingYards'],'values',array['16','3,928']),
    jsonb_build_object('espn_id','3139477','season',2025,'season_type',2,'category','passing','display_name','Passing','team_slug','kansas-city-chiefs','labels',array['GP','YDS'],'names',array['gamesPlayed','passingYards'],'values',array['17','4,100']),
    jsonb_build_object('espn_id','3139477','season',2025,'season_type',2,'category','rushing','display_name','Rushing','team_slug','kansas-city-chiefs','labels',array['GP','YDS'],'names',array['gamesPlayed','rushingYards'],'values',array['17','300']),
    jsonb_build_object('espn_id','3139477','season',2025,'season_type',3,'category','passing','display_name','Passing','team_slug','kansas-city-chiefs','labels',array['GP','YDS'],'names',array['gamesPlayed','passingYards'],'values',array['3','900']),
    jsonb_build_object('espn_id','3139477','season',2021,'season_type',2,'category','broken','display_name','Broken','team_slug',NULL,'labels',array['GP','YDS'],'names',array['a','b'],'values',array['1'])
  ), array['3139477', '999']);
  PERFORM _assert_eq(n::text, '6', 'six well-formed rows written, the broken one dropped');
  PERFORM _assert((SELECT count(*) = 0 FROM player_season_stats WHERE category = 'broken'), 'broken row not stored');

  -- 5. the touched stamp lands on BOTH ids, including the one with no rows
  PERFORM _assert((SELECT stats_refreshed_at IS NOT NULL FROM player_identities WHERE espn_id = '3139477'), 'Mahomes stamped');
  PERFORM _assert((SELECT stats_refreshed_at IS NOT NULL FROM player_identities WHERE espn_id = '999'), 'zero-category player stamped too');
  PERFORM _assert((SELECT stats_refreshed_at IS NULL FROM player_identities WHERE id = 'b0000000-0000-0000-0000-000000000002'), 'untouched identity not stamped');

  -- 6. the read: latest 3 regular seasons, newest first, category order within a season; postseason excluded
  r := get_player_season_stats('a0000000-0000-0000-0000-000000000001', 3);
  PERFORM _assert_eq(r->>'espn_id', '3139477', 'espn_id');
  PERFORM _assert_eq(jsonb_array_length(r->'rows')::text, '4', '2025 passing+rushing, 2024, 2023 — 2022 cut, postseason excluded');
  PERFORM _assert_eq(r->'rows'->0->>'season', '2025', 'newest first');
  PERFORM _assert_eq(r->'rows'->0->>'category', 'passing', 'category order within a season');
  PERFORM _assert_eq(r->'rows'->1->>'category', 'rushing', 'second category');
  PERFORM _assert_eq(r->'rows'->3->>'season', '2023', 'third season');
  PERFORM _assert_eq(r->'rows'->0->'values'->>1, '4,100', 'values kept as ESPN gives them');
  PERFORM _assert((r->>'rows_refreshed_at') IS NOT NULL, 'rows_refreshed_at set');

  -- 6b. a traded season: two team lines + a totals line land as THREE rows (the
  --     shape that failed the first production run), and the read returns all
  --     three, the total first
  n := upsert_player_season_stats('nfl', jsonb_build_array(
    jsonb_build_object('espn_id','3139477','season',2022,'season_type',2,'category','receiving','display_name','Receiving','team_slug','team-a','is_total',false,'labels',array['GP'],'names',array['gp'],'values',array['3']),
    jsonb_build_object('espn_id','3139477','season',2022,'season_type',2,'category','receiving','display_name','Receiving','team_slug','team-b','is_total',false,'labels',array['GP'],'names',array['gp'],'values',array['11']),
    jsonb_build_object('espn_id','3139477','season',2022,'season_type',2,'category','receiving','display_name','Receiving','team_slug',NULL,'is_total',true,'labels',array['GP'],'names',array['gp'],'values',array['14']),
    jsonb_build_object('espn_id','3139477','season',2022,'season_type',2,'category','receiving','display_name','Receiving','team_slug','team-b','is_total',false,'labels',array['GP'],'names',array['gp'],'values',array['11'])
  ), NULL);
  PERFORM _assert_eq(n::text, '3', 'two teams + a total = three rows; the duplicate collapsed');
  r := get_player_season_stats('a0000000-0000-0000-0000-000000000001', 4);
  PERFORM _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(r->'rows') x WHERE x->>'season' = '2022' AND x->>'category' = 'receiving'), '3', 'the read carries all three lines');
  PERFORM _assert_eq((SELECT x->>'is_total' FROM jsonb_array_elements(r->'rows') x WHERE x->>'season' = '2022' AND x->>'category' = 'receiving' LIMIT 1), 'true', 'the total is first');
  PERFORM _assert((SELECT x->'team_slug' = 'null'::jsonb FROM jsonb_array_elements(r->'rows') x WHERE x->>'season' = '2022' AND x->>'category' = 'receiving' LIMIT 1), 'the total reads team_slug null, not empty string');

  -- 7. a re-upsert of a changed line replaces it (no duplicate key, new values)
  n := upsert_player_season_stats('nfl', jsonb_build_array(
    jsonb_build_object('espn_id','3139477','season',2025,'season_type',2,'category','passing','display_name','Passing','team_slug','kansas-city-chiefs','labels',array['GP','YDS'],'names',array['gamesPlayed','passingYards'],'values',array['17','4,250'])
  ), NULL);
  PERFORM _assert_eq(n::text, '1', 'one row replaced');
  PERFORM _assert_eq((SELECT "values"[2] FROM player_season_stats WHERE espn_id = '3139477' AND season = 2025 AND category = 'passing' AND season_type = 2 AND team_slug = 'kansas-city-chiefs'), '4,250', 'replaced value');
  PERFORM _assert_eq((SELECT count(*)::text FROM player_season_stats WHERE espn_id = '3139477'), '9', 'still nine rows');

  -- 8. unknown league refused
  BEGIN
    PERFORM upsert_player_season_stats('mlb', '[]'::jsonb, NULL);
    RAISE EXCEPTION 'ASSERT FAILED: unknown league accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%unknown league%' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;

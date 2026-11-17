-- 2026-09-25 (PT) — player_season_stats is keyed by TEAM too: the first
-- production run of player-stats-sync (4:49 PM PT, 300 All Day players) landed
-- 0 of 8 chunks with "ON CONFLICT DO UPDATE command cannot affect row a second
-- time" — the honest terminal row named it. ESPN answers a traded season as
-- one line PER TEAM plus a "<year> Totals" line (Davante Adams 2024: Raiders 3
-- games, Jets 11, Totals 14), so (season, category) is not unique within one
-- athlete's payload and the 20260925233446 primary key was wrong.
--
-- (1) team_slug becomes part of the key ('' for a totals line), is_total marks
--     the season total. The table was empty (nothing had landed), so the key is
--     rebuilt in place.
-- (2) upsert_player_season_stats takes team_slug/is_total into the key.
-- (3) get_player_season_stats returns is_total; the page prefers the totals
--     line for a traded season and lists the per-team lines otherwise.
--
-- Revert: re-apply 20260925233446 (the table was empty at both points).

ALTER TABLE public.player_season_stats DROP CONSTRAINT IF EXISTS player_season_stats_pkey;
ALTER TABLE public.player_season_stats
  ALTER COLUMN team_slug SET DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_total boolean NOT NULL DEFAULT false;
UPDATE public.player_season_stats SET team_slug = '' WHERE team_slug IS NULL;
ALTER TABLE public.player_season_stats ALTER COLUMN team_slug SET NOT NULL;
ALTER TABLE public.player_season_stats
  ADD PRIMARY KEY (league, espn_id, season, season_type, category, team_slug);

-- anon-exec: intentional — full-body write of upsert_player_season_stats; its ACL
-- (service_role only, set in 20260925233446) is unchanged by CREATE OR REPLACE
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

-- anon-exec: intentional — full-body write of get_player_season_stats; its ACL
-- (service_role only, set in 20260925233446) is unchanged by CREATE OR REPLACE
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

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_constraint WHERE conname = 'player_season_stats_pkey' AND conrelid = 'public.player_season_stats'::regclass;
  IF v_n <> 1 THEN RAISE EXCEPTION 'player_season_stats: primary key missing'; END IF;
  -- the shape that broke the first run now lands: two teams + a total in one season
  PERFORM public.upsert_player_season_stats('nfl', jsonb_build_array(
    jsonb_build_object('espn_id','__probe__','season',2024,'season_type',2,'category','receiving','team_slug','las-vegas-raiders','is_total',false,'labels',array['GP'],'names',array['gp'],'values',array['3']),
    jsonb_build_object('espn_id','__probe__','season',2024,'season_type',2,'category','receiving','team_slug','new-york-jets','is_total',false,'labels',array['GP'],'names',array['gp'],'values',array['11']),
    jsonb_build_object('espn_id','__probe__','season',2024,'season_type',2,'category','receiving','team_slug',NULL,'is_total',true,'labels',array['GP'],'names',array['gp'],'values',array['14'])
  ), NULL);
  SELECT count(*) INTO v_n FROM public.player_season_stats WHERE espn_id = '__probe__';
  IF v_n <> 3 THEN RAISE EXCEPTION 'player_season_stats: probe wrote % rows, want 3', v_n; END IF;
  DELETE FROM public.player_season_stats WHERE espn_id = '__probe__';
END $$;

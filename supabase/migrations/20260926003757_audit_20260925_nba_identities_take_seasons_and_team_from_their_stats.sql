-- 2026-09-25 (PT) — the NBA half of the crosswalk becomes FEED-BACKED from
-- its own stats: an identity seeded from players.external_id has no seasons or
-- team (the NBA publishes no nflverse-style roster file), so
-- resolve_player_identity — which only trusts identities whose seasons are
-- known — could not take part on Top Shot, and every Top Shot label still
-- resolved by name alone. ESPN's per-season lines carry exactly those facts:
-- the first and last season, and the team of the latest one.
--
-- upsert_player_season_stats now derives rookie_season / last_season /
-- latest_team for every touched identity whose source is NOT a league feed
-- (nflverse rows keep nflverse's values), and the 236 Top Shot identities that
-- already carry stats are backfilled here. From this point a Top Shot label
-- whose base name matches a feed-backed identity resolves by game year and
-- team like an All Day label does.
--
-- Revert: re-apply upsert_player_season_stats from 20260925235606;
-- UPDATE player_identities SET rookie_season = NULL, last_season = NULL,
-- latest_team = NULL WHERE source = 'players.external_id'.

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

    -- 2026-09-25: an identity no league feed describes (the NBA half, seeded
    -- from ids) takes its seasons and latest team from its own stat lines;
    -- a feed-described one (nflverse) keeps the feed's values.
    UPDATE public.player_identities i
       SET rookie_season = d.rookie,
           last_season   = d.last,
           latest_team   = COALESCE(d.abbr, i.latest_team)
      FROM (
        SELECT s.espn_id, min(s.season) AS rookie, max(s.season) AS last,
               (SELECT t.abbr
                  FROM public.league_team_abbr(p_league) t
                 WHERE regexp_replace(lower(t.team_name), '[^a-z0-9]+', '-', 'g') = (
                         SELECT s2.team_slug FROM public.player_season_stats s2
                          WHERE s2.league = p_league AND s2.espn_id = s.espn_id
                            AND s2.season_type = 2 AND s2.team_slug <> ''
                          ORDER BY s2.season DESC LIMIT 1)
                 LIMIT 1) AS abbr
          FROM public.player_season_stats s
         WHERE s.league = p_league AND s.season_type = 2 AND s.espn_id = ANY (p_touched)
         GROUP BY s.espn_id
      ) d
     WHERE i.league = p_league AND i.espn_id = d.espn_id AND i.source <> 'nflverse';
  END IF;
  RETURN v_n;
END
$function$;

-- Backfill: every identity that already carries stat lines and no league feed
DO $$
DECLARE v_ids text[]; v_before int; v_after int; r jsonb;
BEGIN
  SELECT count(*) INTO v_before FROM public.player_identities WHERE league = 'nba' AND rookie_season IS NOT NULL;
  SELECT array_agg(DISTINCT s.espn_id) INTO v_ids
    FROM public.player_season_stats s
    JOIN public.player_identities i ON i.league = s.league AND i.espn_id = s.espn_id AND i.source <> 'nflverse'
   WHERE s.league = 'nba';
  IF v_ids IS NOT NULL THEN
    PERFORM public.upsert_player_season_stats('nba', '[]'::jsonb, v_ids);
  END IF;
  SELECT count(*) INTO v_after FROM public.player_identities WHERE league = 'nba' AND rookie_season IS NOT NULL;
  RAISE NOTICE 'nba identities feed-backed: % -> %', v_before, v_after;
  IF v_ids IS NOT NULL AND v_after < array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'backfill: % ids with stats, only % got seasons', array_length(v_ids, 1), v_after;
  END IF;
  -- a Top Shot label now resolves through the crosswalk (Jokić has stats since batch 50)
  IF EXISTS (SELECT 1 FROM public.player_identities WHERE league = 'nba' AND espn_id = '3112335' AND rookie_season IS NOT NULL) THEN
    r := public.resolve_player_identity('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Nikola Jokic', 'Denver Nuggets', '2024-11-01');
    IF r->>'verdict' <> 'one' OR r->>'name_slug' <> 'nikola-jokic' THEN
      RAISE EXCEPTION 'resolve_player_identity: Top Shot Jokic -> %', r;
    END IF;
  END IF;
END $$;

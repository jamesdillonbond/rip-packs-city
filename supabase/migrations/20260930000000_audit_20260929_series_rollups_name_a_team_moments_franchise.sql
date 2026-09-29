-- 2026-09-29 (PT): get_series_rollups names a TEAM moment's franchise (players[].team_name).
-- An internal-link crawl found /nba-top-shot/series/series-4 linking its "Top Players" card for
-- "Los Angeles Lakers" to /nba-top-shot/player/los-angeles-lakers — a 404: a team moment's subject
-- is a franchise, whose page is /team/. The rollup carried no team, so the page could not tell.
-- Each non-Pinnacle players row now carries team_name, set ONLY when the subject is the team: the
-- trimmed player_name equals team_name, or is its city prefix (All Day's "Denver" / "Denver Broncos")
-- — the same rule as lib/entity-href.ts isTeamMoment. The page links through momentSubjectHref.
-- Pinnacle branch, sets, ordering and the LIMIT are unchanged. Only the two `ed` CTEs (+ e.team_name)
-- and the two non-Pinnacle `p` CTEs (+ the team_name aggregate) differ from the live body
-- (base prosrc md5 3e38df8376fce2861be91517c5c60e41 = the pin, re-read right before).
-- Pinned: supabase/tests/get_series_editions.sql claim 5 (both FMV branches); the old body fails it.
--
-- anon-exec: unchanged (get_series_rollups) — CREATE OR REPLACE of an existing fn; ACL preserved; verified 2026-09-29 after apply via has_function_privilege.
--
-- Revert: re-apply the get_series_rollups block from 20260926193906_audit_20260926_pinnacle_series_pages_count_every_pin.sql
CREATE OR REPLACE FUNCTION public.get_series_rollups(p_collection_id uuid, p_series_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_empty         CONSTANT jsonb := jsonb_build_object('sets', '[]'::jsonb, 'players', '[]'::jsonb);
  v_series        RECORD;
  v_pinnacle_year int;
  v_have_current  boolean;
  result          jsonb;
BEGIN
  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN v_empty; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    BEGIN
      v_pinnacle_year := v_series.season::int;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pinnacle_year := NULL;
    END;

    IF v_pinnacle_year IS NULL THEN RETURN v_empty; END IF;

    -- 2026-09-26: from the render catalog (see get_series_editions).
    WITH ed AS (
      SELECT
        regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
        btrim(pc.set_name) AS set_name,
        regexp_replace(lower(btrim(pc.characters[1])), '[^a-z0-9]+', '-', 'g') AS player_slug,
        btrim(pc.characters[1]) AS player_name,
        pc.fmv_usd
      FROM pinnacle_catalog pc
      WHERE pc.series_name = v_pinnacle_year::text
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;

    RETURN COALESCE(result, v_empty);
  END IF;

  SELECT EXISTS (SELECT 1 FROM edition_fmv_current WHERE collection_id = p_collection_id)
  INTO v_have_current;

  IF v_have_current THEN
    WITH ed AS (
      SELECT
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.set_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.player_name,
        e.team_name,
        c.fmv_usd
      FROM editions e
      LEFT JOIN edition_fmv_current c ON c.edition_id = e.id
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total,
             -- 2026-09-29: a TEAM moment's subject is its franchise (/team/), not a player page.
             min(btrim(team_name)) FILTER (WHERE btrim(team_name) = btrim(player_name)
                                              OR starts_with(btrim(team_name), btrim(player_name) || ' ')) AS team_name
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;
  ELSE
    WITH ed AS (
      SELECT
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.set_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.player_name,
        e.team_name,
        fmv.fmv_usd
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total,
             -- 2026-09-29: a TEAM moment's subject is its franchise (/team/), not a player page.
             min(btrim(team_name)) FILTER (WHERE btrim(team_name) = btrim(player_name)
                                              OR starts_with(btrim(team_name), btrim(player_name) || ' ')) AS team_name
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;
  END IF;

  RETURN COALESCE(result, v_empty);
END;
$function$;

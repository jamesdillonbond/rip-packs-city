-- 2026-11-14 (Claude Code cloud, ~2:10 PM PT) — SNAPSHOT, a no-op re-statement of get_series_rollups
-- exactly as 20261114205743's splice left it, so its pin (supabase/tests/get_series_editions.sql)
-- can be re-pointed: the drift guard compares the pin's embedded copy with a full CREATE OR REPLACE
-- in a migration, and a splice file has none (precedent: 20261020150000, 20260925165425).
-- Body md5(prosrc) 37d99a6991cdf1f0af0b64e1df687607 = the live body after the splice (checked before
-- apply), so applying this changes nothing.
-- anon-exec: unchanged (get_series_rollups) — CREATE OR REPLACE of an existing fn; ACL preserved, read 2026-11-14 ~1:50 PM PT has_function_privilege('anon', …, 'EXECUTE') = false.
-- APPLIED as a self-re-execute: `EXECUTE pg_get_functiondef(...)` between two md5 asserts (37d99a…
-- before and after), so no 8 KB body was transcribed through the MCP call; the body below is the
-- pin's copy, whose prosrc md5 was checked equal to the live one before apply.
-- Revert: n/a (no behaviour change); the splice's own revert is in 20261114205743's header.
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
        pc.fmv_usd
      FROM pinnacle_catalog pc
      WHERE pc.series_name = v_pinnacle_year::text
    ),
    -- 2026-11-14: one row per pin x DISTINCT character (a pin tagged Ewok + Wicket counts for both),
    -- matching get_player_detail; `ed` above stays one row per pin for the sets rollup.
    ch AS (
      SELECT regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g') AS player_slug,
             c.name AS player_name,
             pc.fmv_usd
      FROM pinnacle_catalog pc
      CROSS JOIN LATERAL (SELECT DISTINCT btrim(x) AS name FROM unnest(pc.characters) x WHERE btrim(x) <> '') c
      WHERE pc.series_name = v_pinnacle_year::text
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ch WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
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
        e.player_id,
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
      -- 2026-10-25: one card per PERSON (player_id), the label only when it is NULL; name and
      -- slug from the linked players row ("Patrick Mahomes" + "Patrick Mahomes II" were two cards).
      SELECT COALESCE(regexp_replace(lower(trim(pl.name)), '[^a-z0-9]+', '-', 'g'), g.player_slug) AS player_slug,
             COALESCE(pl.name, g.player_name) AS player_name,
             g.edition_count, g.fmv_total, g.team_name
      FROM (
        SELECT (array_agg(player_id) FILTER (WHERE player_id IS NOT NULL))[1] AS player_id,
               min(player_slug) AS player_slug, min(player_name) AS player_name,
               count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total,
               -- 2026-09-29: a TEAM moment's subject is its franchise (/team/), not a player page.
               min(btrim(team_name)) FILTER (WHERE btrim(team_name) = btrim(player_name)
                                                OR starts_with(btrim(team_name), btrim(player_name) || ' ')) AS team_name
        FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
        GROUP BY COALESCE(player_id::text, player_slug)
        ORDER BY fmv_total DESC LIMIT 12
      ) g
      LEFT JOIN players pl ON pl.id = g.player_id AND pl.collection_id = p_collection_id
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
        e.player_id,
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
      -- 2026-10-25: one card per PERSON (player_id), the label only when it is NULL; name and
      -- slug from the linked players row ("Patrick Mahomes" + "Patrick Mahomes II" were two cards).
      SELECT COALESCE(regexp_replace(lower(trim(pl.name)), '[^a-z0-9]+', '-', 'g'), g.player_slug) AS player_slug,
             COALESCE(pl.name, g.player_name) AS player_name,
             g.edition_count, g.fmv_total, g.team_name
      FROM (
        SELECT (array_agg(player_id) FILTER (WHERE player_id IS NOT NULL))[1] AS player_id,
               min(player_slug) AS player_slug, min(player_name) AS player_name,
               count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total,
               -- 2026-09-29: a TEAM moment's subject is its franchise (/team/), not a player page.
               min(btrim(team_name)) FILTER (WHERE btrim(team_name) = btrim(player_name)
                                                OR starts_with(btrim(team_name), btrim(player_name) || ' ')) AS team_name
        FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
        GROUP BY COALESCE(player_id::text, player_slug)
        ORDER BY fmv_total DESC LIMIT 12
      ) g
      LEFT JOIN players pl ON pl.id = g.player_id AND pl.collection_id = p_collection_id
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;
  END IF;

  RETURN COALESCE(result, v_empty);
END;
$function$;

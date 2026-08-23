-- get_series_rollups: same per-edition fmv_snapshots lateral, same read-bound
-- failure. Vercel, 17:29 UTC on /nba-top-shot/series/series-7:
--   [entity-section] series rollups get_series_rollups failed after retries:
--     canceling statement due to statement timeout — degrading to empty
-- It measured 104 ms warm this morning and blew the 8 s ceiling under load, so
-- the "Sets in this Series" / "Top Players" cards were rendering empty.
--
-- Swap the lateral for a hash join to edition_fmv_current. Same aggregates, same
-- shape, same output keys - the only change is where the per-edition FMV comes
-- from.
--
-- ⓘ Staleness here is not a new compromise: these are SUMS of per-edition FMV,
-- and the series totals sitting next to them in get_series_detail have been
-- served from the hourly series_detail_rollup since 03:16 today. Reading a
-- different-aged FMV for the breakdown than for the total would be the
-- inconsistency; this removes it.
--
-- FALLBACK: EXISTS guard on the collection, same as get_series_editions - an
-- unrefreshed rollup must not silently turn every fmv_total into 0, which would
-- reorder both cards and look like real data.
--
-- Pinnacle branch untouched (get_pinnacle_edition_fmv_collapsed, its own path).
--
-- REVERT: previous definition (lateral over fmv_snapshots, no EXISTS guard).
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

    WITH ed AS (
      SELECT
        regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pe.set_name,
        regexp_replace(lower(trim(pe.character_name)), '[^a-z0-9]+', '-', 'g') AS player_slug,
        pe.character_name AS player_name,
        fmv.fmv_usd
      FROM pinnacle_editions pe
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.series_year = v_pinnacle_year
        AND pe.thumbnail_url IS NOT NULL
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
        c.fmv_usd
      FROM editions e
      LEFT JOIN edition_fmv_current c ON c.edition_id = e.id
      WHERE e.collection_id = p_collection_id
        AND e.series = v_series.series_number
        AND e.thumbnail_url IS NOT NULL
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
  ELSE
    WITH ed AS (
      SELECT
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.set_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.player_name,
        fmv.fmv_usd
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = v_series.series_number
        AND e.thumbnail_url IS NOT NULL
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
  END IF;

  RETURN COALESCE(result, v_empty);
END;
$function$;
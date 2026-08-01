-- Snapshot migration: public.get_team_detail(uuid,text).
--
-- SUPERSEDES the get_team_detail block in 20260729000000 (the DB-invariant pin's
-- prior target), which went STALE when the concurrent 2026-08-01 platform audit
-- shipped the unaccented-team-slug 404 fix via the Supabase MCP without a
-- committed migration. Commits the CURRENT LIVE definition verbatim
-- (pg_get_functiondef base64-decoded 2026-08-01; byte-identical, raw md5
-- 888c612a252bac00310facdc04b20a26). Applying it is a no-op against prod.
--
-- What it does: the team/franchise hub read behind /[collection]/team/[slug].
-- The 08-01 change added a diacritic-stripping (extensions.unaccent) FALLBACK
-- lane on both the Pinnacle-franchise and the sports team_name resolution, run
-- ONLY on a would-be 404 so the functional slug index still serves the hot path.

CREATE OR REPLACE FUNCTION public.get_team_detail(p_collection_id uuid, p_team_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_team_variants text[];
  v_team_canonical text;
  v_collection_slug text;
  v_player_count int;
  v_edition_count int;
  v_total_circulation int;
  v_fmv_total numeric;
  v_floor_total numeric;
  -- Team Hub Phase 1: branding (teams_master) + 30d activity. NULL for Pinnacle.
  v_primary_color text;
  v_secondary_color text;
  v_abbreviation text;
  v_team_external_id text;
  v_league text;
  v_sales_30d int;
  v_volume_30d numeric;
  -- Team Hub Phase 4 (F1a): teams_master short slug, the follow-write key.
  v_team_short_slug text;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    SELECT array_agg(DISTINCT franchise),
           (array_agg(franchise ORDER BY franchise))[1]
    INTO v_team_variants, v_team_canonical
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    -- Fallback: accept the diacritic-stripped slug the frontend emits.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT franchise),
             (array_agg(franchise ORDER BY franchise))[1]
      INTO v_team_variants, v_team_canonical
      FROM pinnacle_editions
      WHERE franchise IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(franchise))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
    SELECT
      COUNT(DISTINCT pe.character_name),
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.franchise = ANY(v_team_variants);
    -- Pinnacle: no teams_master branding, no sports sales activity. Leave NULL.
  ELSE
    SELECT array_agg(DISTINCT team_name),
           (array_agg(team_name ORDER BY team_name))[1]
    INTO v_team_variants, v_team_canonical
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    -- Fallback: accept the diacritic-stripped slug the frontend emits
    -- (e.g. atletico-de-madrid for "Atletico de Madrid"). Runs only on a
    -- would-be 404, so the functional index still serves the hot path.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT team_name),
             (array_agg(team_name ORDER BY team_name))[1]
      INTO v_team_variants, v_team_canonical
      FROM editions
      WHERE collection_id = p_collection_id
        AND team_name IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(team_name))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    SELECT
      COUNT(DISTINCT regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'))
        FILTER (WHERE e.player_name IS NOT NULL AND e.player_name <> ''),
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants);

    -- Branding: single indexed lookup on slugified team_name (no cross-league
    -- slug collisions verified among active rows, so no league guard needed).
    SELECT tm.slug, tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id, tm.league::text
    INTO v_team_short_slug, v_primary_color, v_secondary_color, v_abbreviation, v_team_external_id, v_league
    FROM teams_master tm
    WHERE tm.active
      AND regexp_replace(lower(trim(tm.team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug
    LIMIT 1;

    -- 30d activity: bounded by the team's editions via edition_id join. The
    -- s.collection_id = p_collection_id predicate (authoritative, equal to
    -- e.collection_id via the join) lets the planner use the sales
    -- (collection_id, sold_at DESC) partition index instead of scanning the
    -- whole recent slice -> keeps the fn under its 8s cap for big TS franchises.
    SELECT COUNT(*), COALESCE(SUM(s.price_usd), 0)
    INTO v_sales_30d, v_volume_30d
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants)
      AND s.sold_at >= now() - interval '30 days';
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'team_slug',         p_team_slug,
    'team_name',         v_team_canonical,
    'team_name_variants',v_team_variants,
    'is_franchise',      p_collection_id = v_pinnacle_uuid,
    'player_count',      v_player_count,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'primary_color',     v_primary_color,
    'secondary_color',   v_secondary_color,
    'abbreviation',      v_abbreviation,
    'team_external_id',  v_team_external_id,
    'league',            v_league,
    'team_short_slug',   v_team_short_slug,
    'sales_30d',         v_sales_30d,
    'volume_30d_usd',    v_volume_30d
  );
END;
$function$;

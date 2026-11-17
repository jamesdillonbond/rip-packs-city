-- Item 2 finish (2026-06-26 audit): make the Pinnacle SET-page grid per-pin
-- (render-level) so browsing a set lands on the render-keyed per-pin pages
-- (/pinnacle/moment/<render_id>, reached via the edition->moment redirect) instead
-- of the retired set-variant tiles. Both get_set_editions and get_set_detail now
-- source pinnacle_catalog renders, joined by btrim(set_name) (the catalog carries a
-- leading-space formatting quirk vs sets_summary variants — raw '=' matches only
-- 41/50 sets, btrim matches 50/50). thumbnail_url is already the per-render image
-- endpoint. edition_count/editions_with_fmv stay reconciled (both count renders).
-- Revert: CREATE OR REPLACE both back to the pinnacle_editions + get_pinnacle_edition_fmv_collapsed bodies.

CREATE OR REPLACE FUNCTION public.get_set_editions(p_collection_id uuid, p_set_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_variants      text[];
  result          jsonb;
BEGIN
  SELECT set_name_variants INTO v_variants
  FROM sets_summary
  WHERE collection_id = p_collection_id AND set_slug = p_set_slug;

  IF v_variants IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    WITH ed AS (
      SELECT
        pc.render_id                                       AS route_slug,
        pc.character_name                                  AS player_name,
        pc.character_name || ' (' || pc.variant || ')'     AS name,
        pc.variant                                         AS tier,
        NULL::int                                          AS tier_rank,
        pc.series_name                                     AS series_label,
        pc.total_minted                                    AS circulation_count,
        pc.thumbnail_url,
        pc.fmv_usd,
        pc.floor_ask                                       AS floor_usd,
        pc.fmv_confidence::text                            AS fmv_confidence,
        pc.fmv_computed_at                                 AS fmv_computed_at
      FROM pinnacle_catalog pc
      WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_variants) x)
      ORDER BY pc.character_name, pc.variant
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  ELSE
    WITH ed AS (
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        e.name,
        e.tier::text                                       AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1
          WHEN 'LEGENDARY'  THEN 2
          WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4
          WHEN 'CONTENDER'  THEN 5
          WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7
          WHEN 'FANDOM'     THEN 8
          WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.series::text                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence, computed_at
        FROM fmv_snapshots
        WHERE edition_id = e.id
        ORDER BY computed_at DESC
        LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.set_name = ANY(v_variants)
        AND e.thumbnail_url IS NOT NULL
      ORDER BY
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1
          WHEN 'LEGENDARY'  THEN 2
          WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4
          WHEN 'CONTENDER'  THEN 5
          WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7
          WHEN 'FANDOM'     THEN 8
          WHEN 'COMMON'     THEN 9
          ELSE 99
        END,
        e.circulation_count NULLS LAST,
        e.player_name
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_set_detail(p_collection_id uuid, p_set_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_set       RECORD;
  v_fmv_total numeric;
  v_floor_total numeric;
  v_editions_with_fmv int;
  v_edition_count int;
  v_collection_slug text;
BEGIN
  SELECT * INTO v_set
  FROM sets_summary
  WHERE collection_id = p_collection_id
    AND set_slug = p_set_slug;

  IF v_set IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- Render-level (per-pin), matching the get_set_editions grid. Joined by
    -- btrim(set_name) to defuse the catalog leading-space quirk.
    SELECT
      COUNT(*),
      SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0),
      SUM(COALESCE(pc.floor_ask, pc.fmv_usd))          FILTER (WHERE COALESCE(pc.floor_ask, pc.fmv_usd) > 0),
      COUNT(pc.fmv_usd)                                FILTER (WHERE pc.fmv_usd > 0)
    INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
    FROM pinnacle_catalog pc
    WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_set.set_name_variants) x);
  ELSE
    SELECT
      COUNT(*),
      SUM(fmv.fmv_usd)                                          FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd))           FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
      COUNT(fmv.fmv_usd)                                        FILTER (WHERE fmv.fmv_usd > 0)
    INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd
      FROM fmv_snapshots
      WHERE edition_id = e.id
      ORDER BY computed_at DESC
      LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.set_name = ANY(v_set.set_name_variants)
      AND e.thumbnail_url IS NOT NULL;
  END IF;

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'edition_count',       COALESCE(v_edition_count, 0),
    'editions_with_fmv',   v_editions_with_fmv,
    'total_circulation',   v_set.total_circulation,
    'tiers_present',       v_set.tiers_present,
    'min_series',          v_set.min_series,
    'max_series',          v_set.max_series,
    'first_minted_at',     v_set.first_minted_at,
    'last_updated_at',     v_set.last_updated_at,
    'fmv_total_usd',       v_fmv_total,
    'floor_total_usd',     v_floor_total,
    'summary_computed_at', v_set.computed_at
  );
END;
$function$;

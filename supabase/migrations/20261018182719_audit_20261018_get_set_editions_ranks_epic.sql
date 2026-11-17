-- 2026-10-18 11:27 AM PT (Cowork cloud; Trevor "Keep going").
-- get_set_editions orders a set's editions by a hardcoded tier rank (ELSE 99). EPIC is new
-- (20261018160852, UFC's chain tier) and sorted after COMMON. It now ranks 5, between
-- CHAMPION (3) and RARE (6), the slot the fabricated, now-unused CONTENDER held. Body otherwise
-- byte-identical to the live definition read immediately before (pg_get_functiondef, 10-18).
-- Only this function ORDERS BY the tier rank; get_series_editions / get_player_editions sort by
-- FMV, and the team functions serve franchise hubs (UFC has none), so they are not touched.
-- anon-exec: unchanged (get_set_editions) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege('anon', …, 'EXECUTE') = false 2026-10-18.
-- REVERT: re-apply this body without the WHEN 'EPIC' line.
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
    WITH pick AS (
      -- PHASE 1: ordering keys only. All three come from `editions`, so this
      -- picks exactly the rows the old single-CTE form would have kept.
      SELECT
        e.id,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1
          WHEN 'LEGENDARY'  THEN 2
          WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4
          WHEN 'CONTENDER'  THEN 5
          WHEN 'EPIC'       THEN 5
          WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7
          WHEN 'FANDOM'     THEN 8
          WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.circulation_count,
        e.player_name
      FROM editions e
      WHERE e.collection_id = p_collection_id
        AND e.set_name = ANY(v_variants)
        AND e.thumbnail_url IS NOT NULL
      ORDER BY 2, e.circulation_count NULLS LAST, e.player_name
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      -- PHASE 2: FMV lateral + entity_rep_nft_id, over v_safe_limit rows.
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        e.name,
        e.tier::text                                       AS tier,
        p.tier_rank                                        AS tier_rank,
        public.series_display_label(p_collection_id, e.series::int)                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.subedition_name,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence, computed_at
        FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC
        LIMIT 1
      ) fmv ON true
      ORDER BY p.tier_rank, p.circulation_count NULLS LAST, p.player_name
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;

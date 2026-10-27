-- audit_20261026: Team Squeeze on All Day team pages (All Day ↔ Top Shot parity, pass 3).
--
-- get_team_squeeze returned '[]' for every collection but Top Shot, so All Day team pages had no squeeze panel. All Day's
-- badge_editions carries locked + burned from the same Atlas ingest Top Shot uses (allday-badge-ingest; 10-26: locked on
-- 5,442 / burned on 4,431 of 5,607 editions; locked+burned never exceeds circulation). This adds an All Day arm with the
-- topshot_squeeze_board formulas (pct = 100 × count / circulation, effectively_buyable = circulation − locked − burned).
-- Differences, on purpose:
--   * an edition is included only when BOTH counts were read — an unread count is unknown, never 0 % (three states);
--   * low_ask is the verified floor (allday_edition_floor_ask), not badge_editions.low_ask;
--   * deterministic tiebreak on external_id.
-- The Top Shot arm is byte-for-byte the live body (prosrc re-read 10-26 ~9:20 PM PT). SECDEF / search_path / 8 s kept.
--
-- Revert: re-apply 20261003181445_audit_20261003_squeeze_board_carries_team_name.sql's get_team_squeeze body
--         (the Top Shot-only early return).

-- anon-exec: unchanged (get_team_squeeze) — CREATE OR REPLACE of an existing fn; ACL preserved (anon cannot execute, read 2026-10-26 ~9:20 PM PT).
CREATE OR REPLACE FUNCTION public.get_team_squeeze(p_collection_id uuid, p_team_slug text, p_limit integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_topshot_uuid CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_allday_uuid  CONSTANT uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_variants     text[];
  v_safe_limit   int := LEAST(GREATEST(COALESCE(p_limit, 12), 1), 50);
  result         jsonb;
BEGIN
  -- Top Shot (topshot_squeeze_board) and All Day (badge_editions, 10-26); self-hide elsewhere.
  IF p_collection_id IS DISTINCT FROM v_topshot_uuid AND p_collection_id IS DISTINCT FROM v_allday_uuid THEN RETURN '[]'::jsonb; END IF;

  SELECT array_agg(DISTINCT team_name) INTO v_variants
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name IS NOT NULL
    AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)
  IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_allday_uuid THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
      SELECT
        e.external_id AS route_slug,
        COALESCE(e.player_name, be.player_name) AS player_name,
        COALESCE(e.set_name, be.set_name) AS set_name,
        e.team_name,
        e.play_type,
        COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_', '')) AS tier,
        round(100.0 * (be.locked + be.burned) / c.circ, 1) AS squeeze_pct,
        round(100.0 * be.locked / c.circ, 1) AS lock_pct,
        round(100.0 * be.burned / c.circ, 1) AS burn_pct,
        GREATEST(c.circ - be.locked - be.burned, 0) AS effectively_buyable,
        c.circ AS circulation,
        fa.floor_ask AS low_ask,
        efc.fmv_usd::numeric(12,4) AS fmv_usd,
        e.thumbnail_url
      FROM badge_editions be
      JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
      CROSS JOIN LATERAL (SELECT COALESCE(e.circulation_count, be.circulation_count) AS circ) c
      LEFT JOIN allday_edition_floor_ask fa ON fa.edition_id = e.id
      LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
      WHERE e.collection_id = v_allday_uuid
        AND be.collection_id = v_allday_uuid
        AND e.team_name = ANY(v_variants)
        AND be.locked IS NOT NULL
        AND be.burned IS NOT NULL
        AND c.circ > 0
      ORDER BY 7 DESC NULLS LAST, e.external_id
      LIMIT v_safe_limit
    ) t;
    RETURN result;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
    SELECT
      COALESCE(e.external_id, e.id::text) AS route_slug,
      sb.player_name,
      sb.set_name,
      e.team_name,
      e.play_type,
      sb.tier,
      sb.squeeze_pct,
      sb.lock_pct,
      sb.burn_pct,
      sb.effectively_buyable,
      sb.circulation,
      sb.low_ask,
      sb.fmv_usd,
      sb.thumbnail_url
    FROM topshot_squeeze_board sb
    JOIN editions e ON e.id = sb.edition_id
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_variants)
    ORDER BY sb.squeeze_pct DESC NULLS LAST
    LIMIT v_safe_limit
  ) t;

  RETURN result;
END;
$function$;

-- Snapshot migration: public.detect_floor_drops(text, numeric, integer).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- An insider-signal detector: emits a 'floor_drop' alert when an edition's floor
-- fell >= p_min_drop_pct over ~24h. It is guarded so it only fires on a REAL,
-- LIQUID drop, not noise: prior floor must be > $5 (no penny editions), the
-- edition must have >= p_min_recent_sales sales in 24h (liquidity), and no
-- duplicate alert may exist within 12h. Severity bands on drop size. A regression
-- in any guard FABRICATES a market signal (or drops a real one) — the exact class
-- the platform must never get wrong.
--
-- Pinned by supabase/tests/detect_floor_drops.sql.

CREATE OR REPLACE FUNCTION public.detect_floor_drops(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_drop_pct numeric DEFAULT 30.0, p_min_recent_sales integer DEFAULT 3)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted int := 0;
  v_collection_id uuid;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH
  recent_floors AS (
    SELECT DISTINCT ON (edition_id) edition_id, floor_price_usd AS now_floor, computed_at
    FROM fmv_snapshots
    WHERE collection_id = v_collection_id AND floor_price_usd IS NOT NULL
      AND computed_at > NOW() - INTERVAL '6 hours'
    ORDER BY edition_id, computed_at DESC
  ),
  prior_floors AS (
    SELECT DISTINCT ON (edition_id) edition_id, floor_price_usd AS prior_floor, computed_at
    FROM fmv_snapshots
    WHERE collection_id = v_collection_id AND floor_price_usd IS NOT NULL
      AND computed_at BETWEEN NOW() - INTERVAL '36 hours' AND NOW() - INTERVAL '20 hours'
    ORDER BY edition_id, computed_at DESC
  ),
  recent_sales_check AS (
    SELECT edition_id, COUNT(*) AS sales_24h
    FROM sales
    WHERE collection_id = v_collection_id AND sold_at > NOW() - INTERVAL '24 hours'
      AND edition_id IS NOT NULL
    GROUP BY edition_id
    HAVING COUNT(*) >= p_min_recent_sales
  ),
  drops AS (
    SELECT r.edition_id, r.now_floor, p.prior_floor,
      ROUND(100.0 * (p.prior_floor - r.now_floor) / NULLIF(p.prior_floor, 0), 1) AS drop_pct,
      rsc.sales_24h, e.player_name, e.set_name, e.tier
    FROM recent_floors r
    JOIN prior_floors p USING (edition_id)
    JOIN recent_sales_check rsc USING (edition_id)
    JOIN editions e ON e.id = r.edition_id
    WHERE p.prior_floor > r.now_floor
      AND (p.prior_floor - r.now_floor) / NULLIF(p.prior_floor, 0) * 100 >= p_min_drop_pct
      AND p.prior_floor > 5
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts a
        WHERE a.alert_type = 'floor_drop'
          AND a.evidence_jsonb->>'edition_id' = r.edition_id::text
          AND a.generated_at > NOW() - INTERVAL '12 hours'
      )
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'floor_drop',
    format('%s · %s · floor down %s%% in 24h ($%s → $%s)', player_name, set_name, drop_pct, prior_floor, now_floor),
    format('%s drops floor by %s%% in 24h with %s active sales. Was $%s, now $%s.',
           player_name, drop_pct, sales_24h, prior_floor, now_floor),
    jsonb_build_object(
      'edition_id', edition_id, 'collection_slug', p_collection_slug,
      'now_floor_usd', now_floor, 'prior_floor_usd', prior_floor,
      'drop_pct', drop_pct, 'sales_24h', sales_24h,
      'tier', tier, 'player_name', player_name, 'set_name', set_name
    ),
    CASE WHEN drop_pct > 60 THEN 3 WHEN drop_pct > 45 THEN 2 ELSE 1 END::smallint,
    NOW(), NOW() + INTERVAL '24 hours'
  FROM drops;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;

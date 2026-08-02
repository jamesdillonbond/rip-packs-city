-- Snapshot migration: public.detect_unusual_edition_volume(text, integer, numeric).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- An insider-signal detector: flags an edition whose 24h sales exceed its 14-day
-- baseline daily rate by >= p_multiplier. Guards against a fabricated surge: needs
-- >= p_min_24h_sales in 24h, a baseline of >= 0.5 sales/day (so a brand-NEW
-- edition with no history is never called a "surge"), a tier-scaled minimum
-- dollar volume, and a 12h dedup. Severity bands on the observed multiplier.
--
-- Pinned by supabase/tests/detect_unusual_edition_volume.sql.

CREATE OR REPLACE FUNCTION public.detect_unusual_edition_volume(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_24h_sales integer DEFAULT 5, p_multiplier numeric DEFAULT 10.0)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_examined int := 0;
  v_collection_id uuid;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH
  per_edition_24h AS (
    SELECT s.edition_id, COUNT(*) AS sales_24h, AVG(s.price_usd) AS avg_price_24h
    FROM sales s
    WHERE s.collection_id = v_collection_id
      AND s.sold_at > NOW() - INTERVAL '24 hours'
      AND s.edition_id IS NOT NULL
    GROUP BY s.edition_id
    HAVING COUNT(*) >= p_min_24h_sales
  ),
  per_edition_baseline AS (
    SELECT
      pe.edition_id, pe.sales_24h, pe.avg_price_24h,
      (SELECT COUNT(*)::numeric / 14 FROM sales s
       WHERE s.edition_id = pe.edition_id
         AND s.sold_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '24 hours'
      ) AS baseline_daily_sales
    FROM per_edition_24h pe
  ),
  flagged AS (
    SELECT eb.*, e.player_name, e.set_name, e.tier
    FROM per_edition_baseline eb
    JOIN editions e ON e.id = eb.edition_id
    WHERE eb.baseline_daily_sales >= 0.5
      AND eb.sales_24h > eb.baseline_daily_sales * p_multiplier
      AND eb.avg_price_24h * eb.sales_24h >= CASE UPPER(COALESCE(e.tier::text, ''))
        WHEN 'FANDOM'    THEN 25
        WHEN 'COMMON'    THEN 50
        WHEN 'RARE'      THEN 250
        WHEN 'LEGENDARY' THEN 1500
        WHEN 'ULTIMATE'  THEN 0
        ELSE 50
      END
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts a
        WHERE a.alert_type = 'unusual_edition_volume'
          AND a.evidence_jsonb->>'edition_id' = eb.edition_id::text
          AND a.generated_at > NOW() - INTERVAL '12 hours'
      )
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'unusual_edition_volume',
    format('%s · %s · %s sales/24h (%sx baseline)',
           player_name, set_name, sales_24h,
           ROUND(sales_24h / NULLIF(baseline_daily_sales, 0), 1)),
    format('%s sales in last 24h vs %s/day baseline (14d) — %sx surge. Avg price $%s.',
           sales_24h, ROUND(baseline_daily_sales, 1),
           ROUND(sales_24h / NULLIF(baseline_daily_sales, 0), 1),
           ROUND(avg_price_24h, 2)),
    jsonb_build_object(
      'edition_id', edition_id, 'collection_slug', p_collection_slug,
      'sales_24h', sales_24h, 'avg_price_24h', avg_price_24h,
      'baseline_daily_sales', baseline_daily_sales,
      'multiplier_observed', sales_24h / NULLIF(baseline_daily_sales, 0),
      'total_24h_dollars', avg_price_24h * sales_24h,
      'tier', tier, 'player_name', player_name, 'set_name', set_name
    ),
    CASE
      WHEN sales_24h / NULLIF(baseline_daily_sales, 0) >= 50 THEN 3
      WHEN sales_24h / NULLIF(baseline_daily_sales, 0) >= 20 THEN 2
      ELSE 1
    END::smallint,
    NOW(),
    NOW() + INTERVAL '48 hours'
  FROM flagged;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  SELECT COUNT(*) INTO v_examined FROM sales
   WHERE collection_id = v_collection_id AND sold_at > NOW() - INTERVAL '24 hours' AND edition_id IS NOT NULL;

  RETURN json_build_object(
    'collection', p_collection_slug,
    'sales_examined_24h', v_examined,
    'alerts_inserted', v_inserted,
    'min_24h_sales_threshold', p_min_24h_sales,
    'baseline_multiplier', p_multiplier
  );
END;
$function$;

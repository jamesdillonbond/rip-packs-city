-- audit_20260927_pinnacle_fmv_recency_weighted_median
--
-- Register #155. The Disney Pinnacle render price was a 90-day recency-weighted
-- AVERAGE, re-averaged after trimming sales outside 0.33x–3x of that average.
-- When a render's price FALLS, its recent low sales are exactly what the trim
-- removes: Minnie Mouse (D23 Expedition, Colored Enamel, OEEV1-EXPD-MINN-E2)
-- read $21.56 MEDIUM against 30-day sales of $3 and $6 and a $2 floor, and the
-- Pinnacle Sniper ranked it its best "deal" (91% off).
--
-- Now the price is the RECENCY-WEIGHTED MEDIAN of the same sales (same window,
-- same exp(-0.03 x days) weights). Everything else — confidence, counts, days,
-- liquidity, wap_usd (the untrimmed weighted mean) — is unchanged.
--
-- Backtest 2026-09-27 (predict each render's latest sale from the sales before it):
--   target = latest sale in 30 d (1,145 renders): median abs error 19.0% -> 9.4%,
--            priced > 2x the sale 27 -> 11; wins in every liquidity bucket
--            (mean |log error| 0.296->0.258 liquid, 0.241->0.191 mid, 0.237->0.231 thin)
--   target = latest sale 7–40 d ago (1,158 renders): 19.4% -> 12.5%, > 2x 40 -> 11
--   no bias: median predicted/actual = 1.00 for both.
--
-- This is the function's first committed definition (it predates the repo's
-- migration history); the header is the live one (pg_get_functiondef). It is
-- pinned from today: supabase/tests/pinnacle_fmv_recalc_render.sql.
--
-- anon-exec: unchanged (pinnacle_fmv_recalc_render) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false, authenticated=false.
--
-- Revert: re-apply this previous body (live until 2026-09-27, prosrc md5
-- 92364c51a4a1e2eab98215e6a751cd5d), then SELECT public.pinnacle_fmv_recalc_render_all();
--
--   (header identical to the CREATE below; previous body follows)
--   DECLARE
--     v_wap numeric; v_wap_no numeric; v_s7 int; v_s30 int; v_days int; v_conf text; v_liq int;
--   BEGIN
--     SELECT
--       ROUND(SUM(sale_price_usd * weight) / NULLIF(SUM(weight), 0), 4),
--       COUNT(*) FILTER (WHERE sold_at > NOW() - interval '7 days'),
--       COUNT(*) FILTER (WHERE sold_at > NOW() - interval '30 days'),
--       EXTRACT(DAY FROM NOW() - MAX(sold_at))::int
--     INTO v_wap, v_s7, v_s30, v_days
--     FROM (
--       SELECT sale_price_usd, sold_at, EXP(-0.03 * EXTRACT(DAY FROM NOW() - sold_at)) AS weight
--       FROM pinnacle_sales
--       WHERE render_id = p_render_id AND sold_at > NOW() - interval '90 days' AND sale_price_usd > 0
--     ) weighted;
--
--     IF v_wap IS NOT NULL AND v_wap > 0 THEN
--       SELECT ROUND(SUM(sale_price_usd * weight) / NULLIF(SUM(weight), 0), 4)
--       INTO v_wap_no
--       FROM (
--         SELECT sale_price_usd, EXP(-0.03 * EXTRACT(DAY FROM NOW() - sold_at)) AS weight
--         FROM pinnacle_sales
--         WHERE render_id = p_render_id AND sold_at > NOW() - interval '90 days'
--           AND sale_price_usd > 0 AND sale_price_usd BETWEEN v_wap * 0.33 AND v_wap * 3.0
--       ) filtered;
--     END IF;
--
--     v_conf := CASE
--       WHEN v_s30 >= 5 AND v_days <= 14 THEN 'HIGH'
--       WHEN v_s30 >= 2 AND v_days <= 30 THEN 'MEDIUM'
--       WHEN v_s30 >= 1 THEN 'LOW'
--       WHEN v_wap IS NOT NULL AND v_wap > 0 THEN 'STALE'
--       ELSE 'NO_DATA' END;
--     v_liq := CASE
--       WHEN v_s30 >= 20 THEN 5 WHEN v_s30 >= 10 THEN 4 WHEN v_s30 >= 5 THEN 3
--       WHEN v_s30 >= 2 THEN 2 WHEN v_s30 >= 1 THEN 1 ELSE 0 END;
--
--     RETURN json_build_object(
--       'render_id', p_render_id,
--       'fmv_usd', COALESCE(v_wap_no, v_wap),
--       'wap_usd', v_wap,
--       'confidence', v_conf,
--       'liquidity_rating', v_liq,
--       'sales_count_7d', COALESCE(v_s7, 0),
--       'sales_count_30d', COALESCE(v_s30, 0),
--       'days_since_sale', v_days,
--       'computed_at', NOW()
--     );
--   END;

CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_render(p_render_id text)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wap numeric; v_wmed numeric; v_s7 int; v_s30 int; v_days int; v_conf text; v_liq int;
BEGIN
  SELECT
    ROUND(SUM(sale_price_usd * weight) / NULLIF(SUM(weight), 0), 4),
    COUNT(*) FILTER (WHERE sold_at > NOW() - interval '7 days'),
    COUNT(*) FILTER (WHERE sold_at > NOW() - interval '30 days'),
    EXTRACT(DAY FROM NOW() - MAX(sold_at))::int
  INTO v_wap, v_s7, v_s30, v_days
  FROM (
    SELECT sale_price_usd, sold_at, EXP(-0.03 * EXTRACT(DAY FROM NOW() - sold_at)) AS weight
    FROM pinnacle_sales
    WHERE render_id = p_render_id AND sold_at > NOW() - interval '90 days' AND sale_price_usd > 0
  ) weighted;

  -- The price: the RECENCY-WEIGHTED MEDIAN of the same 90-day sales — the lowest
  -- price at which the cumulative weight (prices ascending) reaches half the total.
  -- Replaces a WAP-centred 0.33x-3x trim that removed a FALLING render's recent
  -- sales as "outliers" (2026-09-27, register #155).
  IF v_wap IS NOT NULL AND v_wap > 0 THEN
    SELECT MIN(sale_price_usd) FILTER (WHERE cum_weight >= total_weight / 2)
    INTO v_wmed
    FROM (
      SELECT sale_price_usd,
             SUM(weight) OVER (ORDER BY sale_price_usd, sold_at ROWS UNBOUNDED PRECEDING) AS cum_weight,
             SUM(weight) OVER () AS total_weight
      FROM (
        SELECT sale_price_usd, sold_at, EXP(-0.03 * EXTRACT(DAY FROM NOW() - sold_at)) AS weight
        FROM pinnacle_sales
        WHERE render_id = p_render_id AND sold_at > NOW() - interval '90 days' AND sale_price_usd > 0
      ) w
    ) c;
  END IF;

  v_conf := CASE
    WHEN v_s30 >= 5 AND v_days <= 14 THEN 'HIGH'
    WHEN v_s30 >= 2 AND v_days <= 30 THEN 'MEDIUM'
    WHEN v_s30 >= 1 THEN 'LOW'
    WHEN v_wap IS NOT NULL AND v_wap > 0 THEN 'STALE'
    ELSE 'NO_DATA' END;
  v_liq := CASE
    WHEN v_s30 >= 20 THEN 5 WHEN v_s30 >= 10 THEN 4 WHEN v_s30 >= 5 THEN 3
    WHEN v_s30 >= 2 THEN 2 WHEN v_s30 >= 1 THEN 1 ELSE 0 END;

  RETURN json_build_object(
    'render_id', p_render_id,
    'fmv_usd', COALESCE(ROUND(v_wmed, 4), v_wap),
    'wap_usd', v_wap,
    'confidence', v_conf,
    'liquidity_rating', v_liq,
    'sales_count_7d', COALESCE(v_s7, 0),
    'sales_count_30d', COALESCE(v_s30, 0),
    'days_since_sale', v_days,
    'computed_at', NOW()
  );
END;
$function$;

SELECT public.pinnacle_fmv_recalc_render_all();

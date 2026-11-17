-- 2026-09-29 (Pinnacle page audit, Overview deals): cap the render FMV at the
-- 30-day max sale when the render has 2+ sales in 30 days. The recency-weighted
-- median (#155) is the best estimator overall (backtest: lambda 0.03 beat
-- 0.05-0.2), but on a FALLING render it lags, and the Overview/Sniper rank deals
-- by discount, so the lag cases are what gets headlined (3 of the 5 Overview
-- deals on 09-28 had an FMV above every sale of the last 30 days). Numbers in
-- the function comment. Live effect at authoring: 21 renders lowered (median
-- x0.82); of the 8 that read as 20%+ deals, 3 still do.
-- Revert: re-apply the body in 20260927203001_audit_20260927_pinnacle_fmv_recency_weighted_median.sql,
-- then SELECT public.pinnacle_fmv_recalc_render_all();

-- anon-exec: unchanged (pinnacle_fmv_recalc_render) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_render(p_render_id text)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wap numeric; v_wmed numeric; v_s7 int; v_s30 int; v_days int; v_conf text; v_liq int;
  v_max30 numeric;
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

  -- Capped at the 30-day MAX SALE when the render has 2+ sales in 30 days
  -- (2026-09-29). On a falling render the 90-day median lags: Nemo priced $9.50
  -- over 30-day sales of $3-$6, and ranking deals by discount surfaces exactly
  -- those lags. Backtest (simulated engine at each sale, next sale as truth): of
  -- the cases whose median sat above the 30-day max, capping cut mean |log err|
  -- 0.434 -> 0.366 (2-3 recent sales; 30 better / 18 worse) and 0.572 -> 0.382
  -- (4+; 20 / 4). With ONE recent sale the cap was worse (0.282 -> 0.312), so a
  -- lone sale never caps. The cap only ever LOWERS the price.
  IF v_wmed IS NOT NULL AND COALESCE(v_s30, 0) >= 2 THEN
    SELECT MAX(sale_price_usd) INTO v_max30
    FROM pinnacle_sales
    WHERE render_id = p_render_id AND sold_at > NOW() - interval '30 days' AND sale_price_usd > 0;
    IF v_max30 IS NOT NULL AND v_wmed > v_max30 THEN
      v_wmed := v_max30;
    END IF;
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

-- audit_20261009_pinnacle_young_render_fmv_last5_and_no_drop_day_high
--
-- 2026-10-09 ~2:40 PM PT (Claude Code, cloud). The daytime pass's open pricing call (handoff
-- 2026-10-09, "Drop-day FMV on a falling render"): Wick LEV1-SWHA-WICK-S6 sold 45 -> 37 -> 23 -> 50 -> 20
-- on its first morning and read $37 HIGH against a $21 floor, so a deals surface ranks the floor 43 %
-- off. Trevor: "Make decisions based upon what's best for RPC long term and for our users."
--
-- MEASURED (pinnacle_sales; renders first sold 2026-06-01..09-20; the engine simulated at render age d,
-- scored against the median sale on days d+3..d+11, >= 2 such sales):
--   engine HIGH on day 1 (5+ sales):  n 281, median |log err| 0.318, median ratio 1.19, 38 % over 1.5x
--   mature HIGH (first sale > 30 d):  n 390,                    0.154,               1.00,  6 % over 1.5x
--   by age (5+ sales): d1 0.405 / 1.28 / 40 %, d2 0.347 / 1.20 / 37 %, d3 0.223 / 1.00 / 26 %,
--                      d5 0.223 / 1.00 / 23 %, d7 0.095 / 1.00 / 15 %, d10 0.154, d14 0.161.
--   last-5-sales median instead of all sales: better on days 1-5, neutral from day 7 (in the body).
--
-- WHAT THIS DOES (pinnacle_fmv_recalc_render only; wap_usd, counts, liquidity unchanged):
--   · render age = days since its FIRST positive sale. Under 7 days with 5+ sales in 90 d, fmv_usd is
--     the median of the last 5 sales (the 30-day-max cap still applies after it).
--   · confidence: under 3 days at most LOW; 3-6 days at most MEDIUM; 7+ days unchanged.
--   Mature renders are untouched. Re-run pinnacle_fmv_recalc_render_all() after apply.
--
-- anon-exec: unchanged (pinnacle_fmv_recalc_render) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false (2026-10-09).
--
-- Base verified: live prosrc md5 (whitespace-normalised) f1fdcbf39a0189d1d56bfaf285684ef6 = the body in
-- 20260929131423, the newest migration defining this function.
--
-- REVERT: re-apply the pinnacle_fmv_recalc_render block of
--   20260929131423_audit_20260929_pinnacle_fmv_capped_at_30d_max_sale.sql, then SELECT public.pinnacle_fmv_recalc_render_all();

CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_render(p_render_id text)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wap numeric; v_wmed numeric; v_s7 int; v_s30 int; v_days int; v_conf text; v_liq int;
  v_max30 numeric;
  v_age numeric; v_n90 int;
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

  -- A YOUNG render (first sale < 7 days ago) prices at the median of its LAST 5 sales (2026-10-09).
  -- Drop-week sales fall fast and the 90-day median lags them: backtest over renders first sold
  -- 06-01..09-20, engine at day d vs the median sale on days d+3..d+11 -- median |log err| day 1
  -- 0.405 -> 0.365, day 2 0.347 -> 0.288, day 3 0.223 -> 0.172, day 5 0.223 -> 0.140 (better / worse
  -- 33/16, 75/43, 97/39, 87/52); neutral by day 7 (65/64), so mature renders are unchanged.
  SELECT EXTRACT(EPOCH FROM NOW() - MIN(sold_at)) / 86400.0 INTO v_age
  FROM pinnacle_sales WHERE render_id = p_render_id AND sale_price_usd > 0;
  SELECT COUNT(*) INTO v_n90
  FROM pinnacle_sales WHERE render_id = p_render_id AND sold_at > NOW() - interval '90 days' AND sale_price_usd > 0;
  IF v_age IS NOT NULL AND v_age < 7 AND v_n90 >= 5 THEN
    SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY l.sale_price_usd) INTO v_wmed
    FROM (SELECT sale_price_usd FROM pinnacle_sales
           WHERE render_id = p_render_id AND sold_at > NOW() - interval '90 days' AND sale_price_usd > 0
           ORDER BY sold_at DESC LIMIT 5) l;
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
  -- 2026-10-09: a young render cannot be HIGH. Same backtest: "5+ sales on day one" priced the
  -- render 1.19x where it settled (median |log err| 0.318, 38% over 1.5x) vs mature HIGH 1.00x
  -- (0.154, 6%). Under 3 days: biased ~+20% and >1.5x off ~40% of the time -> at most LOW;
  -- 3-6 days: unbiased but ~2x the mature error -> at most MEDIUM; 7+ days: as before.
  IF v_age IS NOT NULL THEN
    IF v_age < 3 AND v_conf IN ('HIGH', 'MEDIUM') THEN
      v_conf := 'LOW';
    ELSIF v_age < 7 AND v_conf = 'HIGH' THEN
      v_conf := 'MEDIUM';
    END IF;
  END IF;
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

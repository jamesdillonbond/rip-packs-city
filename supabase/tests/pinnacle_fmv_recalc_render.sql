-- DB invariant: public.pinnacle_fmv_recalc_render(text) — the per-render Disney
-- Pinnacle PRICE (pinnacle_fmv_recalc_render_all writes it to pinnacle_catalog).
--
-- ⚠ 2026-09-27 (register #155): the price is the RECENCY-WEIGHTED MEDIAN of the
-- render's 90-day sales (weight exp(-0.03 × days)). It replaced a weighted average
-- trimmed to 0.33×–3× of ITSELF, which removed a FALLING render's recent low sales
-- as outliers and published e.g. Minnie Mouse (D23 Expedition) at $21.56 against
-- 30-day sales of $3 and $6. Backtest (predict each render's latest sale from
-- the sales before it, 1,145–1,158 renders, two target sets): median error
-- 19.0–19.4% → 9.4–12.5%, renders priced > 2× the next sale 27–40 → 11.
-- Pins:
--   * the price is the weighted MEDIAN (a single high sale cannot drag it);
--   * recent sales outweigh old ones (a falling render prices near its recent sales);
--   * wap_usd stays the untrimmed weighted MEAN (informational);
--   * non-positive prices and sales older than 90 days are ignored;
--   * confidence / counts / days are unchanged; no sales → NULL price, NO_DATA.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261009205054_audit_20261009_pinnacle_young_render_fmv_last5_and_no_drop_day_high.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_sales (render_id text, sale_price_usd numeric, sold_at timestamptz);

-- >>> BEGIN verbatim pinnacle_fmv_recalc_render (keep byte-identical to the migration) >>>
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
-- <<< END verbatim pinnacle_fmv_recalc_render <<<

-- R1: three $10 sales and one $100 sale, all 1 day old → median 10, mean 32.5.
INSERT INTO public.pinnacle_sales VALUES
  ('R1', 10, now() - interval '1 day 1 hour'), ('R1', 10, now() - interval '1 day 2 hours'),
  ('R1', 10, now() - interval '1 day 3 hours'), ('R1', 100, now() - interval '1 day 4 hours');
-- R2 FALLING: four $18 sales 40 days old (weight ~0.30 each) and two $3 sales 1 day
-- old (~0.97 each) → the recent $3 carries the median.
INSERT INTO public.pinnacle_sales VALUES
  ('R2', 18, now() - interval '40 days 1 hour'), ('R2', 18, now() - interval '40 days 2 hours'),
  ('R2', 18, now() - interval '40 days 3 hours'), ('R2', 18, now() - interval '40 days 4 hours'),
  ('R2', 3, now() - interval '1 day 1 hour'), ('R2', 3, now() - interval '1 day 2 hours');
-- R3: only a 120-day-old sale and a $0 sale → nothing in window.
INSERT INTO public.pinnacle_sales VALUES
  ('R3', 50, now() - interval '120 days'), ('R3', 0, now() - interval '1 day');
-- R4: five recent sales → HIGH; one $0 sale ignored.
INSERT INTO public.pinnacle_sales VALUES
  ('R4', 5, now() - interval '2 days'), ('R4', 6, now() - interval '3 days'), ('R4', 7, now() - interval '4 days'),
  ('R4', 8, now() - interval '5 days'), ('R4', 9, now() - interval '6 days'), ('R4', 0, now() - interval '1 day');

SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R1')->>'fmv_usd')::numeric::text, '10.0000', 'R1: the price is the weighted MEDIAN (10), not the mean');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R1')->>'wap_usd')::numeric::text, '32.5000', 'R1: wap_usd stays the untrimmed weighted mean');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R1')->>'confidence'), 'LOW', 'R1: 4 sales in 30d would be MEDIUM, but the render is 1 day old → at most LOW (2026-10-09)');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R2')->>'fmv_usd')::numeric::text, '3.0000', 'R2: a FALLING render prices at its recent sales, not the trimmed old level');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R3')->>'fmv_usd'), NULL, 'R3: no in-window positive sale → NULL price');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R3')->>'confidence'), 'NO_DATA', 'R3: → NO_DATA');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R4')->>'fmv_usd')::numeric::text, '7.0000', 'R4: weighted median of 5..9 (weights .94/.91/.89/.86/.84 → half the total is reached at 7); the $0 sale ignored');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R4')->>'confidence'), 'MEDIUM', 'R4: 5 sales in 30d would be HIGH, but the render is 6 days old → at most MEDIUM (2026-10-09)');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R4')->>'sales_count_30d'), '5', 'R4: counts ignore the $0 sale');

SELECT '✓ pinnacle_fmv_recalc_render invariants pass' AS result;
-- 2026-09-29: capped at the 30-day max sale when 2+ sales in 30 days; a lone recent sale never caps.
INSERT INTO public.pinnacle_sales VALUES
  ('R5', 20, now() - interval '45 days 1 hour'), ('R5', 20, now() - interval '45 days 2 hours'),
  ('R5', 20, now() - interval '45 days 3 hours'), ('R5', 20, now() - interval '45 days 4 hours'),
  ('R5', 20, now() - interval '45 days 5 hours'), ('R5', 20, now() - interval '45 days 6 hours'),
  ('R5', 20, now() - interval '45 days 7 hours'), ('R5', 20, now() - interval '45 days 8 hours'),
  ('R5', 6, now() - interval '1 day'), ('R5', 8, now() - interval '2 days');
INSERT INTO public.pinnacle_sales VALUES
  ('R6', 20, now() - interval '45 days 1 hour'), ('R6', 20, now() - interval '45 days 2 hours'),
  ('R6', 20, now() - interval '45 days 3 hours'), ('R6', 20, now() - interval '45 days 4 hours'),
  ('R6', 20, now() - interval '45 days 5 hours'), ('R6', 20, now() - interval '45 days 6 hours'),
  ('R6', 20, now() - interval '45 days 7 hours'), ('R6', 20, now() - interval '45 days 8 hours'),
  ('R6', 6, now() - interval '1 day');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R5')->>'fmv_usd')::numeric::text, '8.0000', 'R5: a median (20) above every 30-day sale is capped at the 30-day max (8) with 2 recent sales');
SELECT _assert_eq(((public.pinnacle_fmv_recalc_render('R5')->>'wap_usd')::numeric > 8)::text, 'true', 'R5: wap_usd is not capped');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R6')->>'fmv_usd')::numeric::text, '20.0000', 'R6: ONE recent sale never caps (the backtest found that worse)');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R1')->>'fmv_usd')::numeric::text, '10.0000', 'R1 control: a median below the 30-day max is untouched');

-- 2026-10-09: young renders. R7 MATURE (first sale 40 d ago) with 5 sales this week keeps HIGH and the
-- weighted median; R8 YOUNG (2 d) and falling prices at its last 5 sales and is at most LOW.
INSERT INTO public.pinnacle_sales VALUES
  ('R7', 30, now() - interval '40 days'),
  ('R7', 5, now() - interval '2 days'), ('R7', 6, now() - interval '3 days'), ('R7', 7, now() - interval '4 days'),
  ('R7', 8, now() - interval '5 days'), ('R7', 9, now() - interval '6 days');
INSERT INTO public.pinnacle_sales VALUES
  ('R8', 50, now() - interval '2 days 6 hours'), ('R8', 45, now() - interval '2 days 5 hours'), ('R8', 40, now() - interval '2 days 4 hours'),
  ('R8', 24, now() - interval '1 day 5 hours'), ('R8', 23, now() - interval '1 day 4 hours'), ('R8', 22, now() - interval '1 day 3 hours'),
  ('R8', 21, now() - interval '1 day 2 hours'), ('R8', 20, now() - interval '1 day 1 hour');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R7')->>'confidence'), 'HIGH', 'R7: a MATURE render with 5 recent sales is still HIGH');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R7')->>'fmv_usd')::numeric::text, '7.0000', 'R7: a mature render keeps the weighted median (last-5 rule does not apply)');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R8')->>'fmv_usd')::numeric::text, '22.0000', 'R8: a 2-day-old falling render prices at the median of its last 5 sales (22), not all 8 (24)');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R8')->>'confidence'), 'LOW', 'R8: 8 sales in 30 d, but 2 days old → LOW');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R8')->>'sales_count_30d'), '8', 'R8: counts unchanged by the young-render rule');

ROLLBACK;

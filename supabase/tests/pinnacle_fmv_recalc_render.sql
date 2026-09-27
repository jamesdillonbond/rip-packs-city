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
-- (supabase/migrations/supabase/migrations/20260927203001_audit_20260927_pinnacle_fmv_recency_weighted_median.sql);
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
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R1')->>'confidence'), 'MEDIUM', 'R1: 4 sales in 30d, 1 day old → MEDIUM');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R2')->>'fmv_usd')::numeric::text, '3.0000', 'R2: a FALLING render prices at its recent sales, not the trimmed old level');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R3')->>'fmv_usd'), NULL, 'R3: no in-window positive sale → NULL price');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R3')->>'confidence'), 'NO_DATA', 'R3: → NO_DATA');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R4')->>'fmv_usd')::numeric::text, '7.0000', 'R4: weighted median of 5..9 (weights .94/.91/.89/.86/.84 → half the total is reached at 7); the $0 sale ignored');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R4')->>'confidence'), 'HIGH', 'R4: 5 sales in 30d, newest 2 days → HIGH');
SELECT _assert_eq((public.pinnacle_fmv_recalc_render('R4')->>'sales_count_30d'), '5', 'R4: counts ignore the $0 sale');

SELECT '✓ pinnacle_fmv_recalc_render invariants pass' AS result;
ROLLBACK;

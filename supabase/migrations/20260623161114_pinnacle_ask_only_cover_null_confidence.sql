-- Extend the Pinnacle ASK_ONLY pass to also cover NULL-confidence renders that
-- have a live floor (159 missed by the 'STALE'/'NO_DATA'/'ASK_ONLY' filter), and
-- label the genuinely-unpriced NULL renders NO_DATA for consistency.
-- Surgical extension of 9056eff8's writer; everything else preserved verbatim.
--
-- Applied live 2026-06-23 via Supabase MCP; this file is the repo-parity copy.
CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_render_all()
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count int := 0; v_skipped int := 0; v_ask int := 0; r record; v json; v_started timestamptz := clock_timestamp();
BEGIN
  FOR r IN SELECT DISTINCT render_id FROM pinnacle_sales WHERE render_id IS NOT NULL LOOP
    v := pinnacle_fmv_recalc_render(r.render_id);
    UPDATE public.pinnacle_catalog c
       SET fmv_usd = NULLIF((v->>'fmv_usd'),'')::numeric,
           fmv_wap_usd = NULLIF((v->>'wap_usd'),'')::numeric,
           fmv_confidence = (v->>'confidence')::public.fmv_confidence,
           fmv_sales_count_7d = (v->>'sales_count_7d')::int,
           fmv_sales_count_30d = (v->>'sales_count_30d')::int,
           fmv_days_since_sale = NULLIF((v->>'days_since_sale'),'')::int,
           fmv_liquidity_rating = (v->>'liquidity_rating')::int,
           fmv_computed_at = NOW(),
           fmv_algo_version = 'pinnacle-2.0.0-render'
     WHERE c.render_id = r.render_id;
    IF (v->>'fmv_usd') IS NULL THEN v_skipped := v_skipped + 1; ELSE v_count := v_count + 1; END IF;
  END LOOP;

  -- ASK_ONLY pass: renders with no in-window (30d) sales but a live floor read
  -- as floor × 0.90 (TS parity; LiveToken doesn't cover Pinnacle). Takes
  -- precedence over STALE for stale-sale renders that have a floor.
  -- NULL confidence (never priced) with a floor is included so a live floor is
  -- always surfaced regardless of prior label.
  UPDATE public.pinnacle_catalog c
     SET fmv_usd = ROUND(c.floor_ask * 0.90, 2),
         fmv_confidence = 'ASK_ONLY',
         fmv_computed_at = NOW(),
         fmv_algo_version = 'pinnacle-2.0.0-render-ask'
   WHERE (c.fmv_confidence IN ('STALE','NO_DATA','ASK_ONLY') OR c.fmv_confidence IS NULL)
     AND c.floor_ask > 0 AND c.floor_ask <= 10000;
  GET DIAGNOSTICS v_ask = ROW_COUNT;

  -- Self-correct: an ASK_ONLY render whose floor disappeared (and that the sales
  -- loop did not re-price this run) reverts to NO_DATA — never a stale floor.
  UPDATE public.pinnacle_catalog c
     SET fmv_usd = NULL,
         fmv_confidence = 'NO_DATA',
         fmv_computed_at = NOW(),
         fmv_algo_version = 'pinnacle-2.0.0-render-ask'
   WHERE c.fmv_confidence = 'ASK_ONLY'
     AND (c.floor_ask IS NULL OR c.floor_ask <= 0 OR c.floor_ask > 10000);

  -- Consistency: any render still without a confidence (never in sales, no floor)
  -- is genuinely unpriced -> NO_DATA, not a NULL gap.
  UPDATE public.pinnacle_catalog c
     SET fmv_confidence = 'NO_DATA',
         fmv_computed_at = NOW(),
         fmv_algo_version = 'pinnacle-2.0.0-render-ask'
   WHERE c.fmv_confidence IS NULL;

  PERFORM log_pipeline_run('pinnacle-fmv-recalc', v_started,
    v_count + v_skipped, v_count, v_skipped, true, NULL, 'disney_pinnacle', NULL, NULL,
    json_build_object('renders_priced', v_count, 'renders_no_data', v_skipped, 'renders_ask_only', v_ask)::jsonb);

  RETURN json_build_object('renders_priced', v_count, 'renders_no_data', v_skipped, 'renders_ask_only', v_ask, 'computed_at', NOW());
END;
$function$;

-- Immediate catch-up for the NULL-confidence renders (cheap; no sales loop) so the
-- 159 floor-backed renders surface now instead of waiting for the daily cron tick.
UPDATE public.pinnacle_catalog c
   SET fmv_usd = ROUND(c.floor_ask * 0.90, 2),
       fmv_confidence = 'ASK_ONLY',
       fmv_computed_at = NOW(),
       fmv_algo_version = 'pinnacle-2.0.0-render-ask'
 WHERE c.fmv_confidence IS NULL AND c.floor_ask > 0 AND c.floor_ask <= 10000;

UPDATE public.pinnacle_catalog c
   SET fmv_confidence = 'NO_DATA',
       fmv_computed_at = NOW(),
       fmv_algo_version = 'pinnacle-2.0.0-render-ask'
 WHERE c.fmv_confidence IS NULL;

-- audit_20261021: shadow-log the #202 LOW-tier ask cap for panini-1.4.0, so it can be judged on 10-24.
--
-- known-issues #202: Panini's LOW tier prices at a last-3 median of ANY age and ignores the live ask
-- (Oukidja Base: FMV $198 vs a $1 ask; 64 editions at FMV >= 10x ask). The owed fix -- cap a LOW price by a
-- confirmed live ask -- "cannot be backtested: no table keeps a Panini ask history", so it was to be judged
-- forward by shadow-logging a capped FMV beside the published one. Nothing did that yet (grep 10-21: no
-- capped_fmv / shadow writer). This starts the log. It PRICES NOTHING: no reader of FMV reads this table.
--
--   panini_fmv_ask_cap_shadow           one row per (snapshot, edition) with a confirmed ask: published FMV,
--                                       its tier and engine, the ask, and two candidates:
--                                         capped_low_usd = LEAST(fmv, ask) for LOW only (the #202 proposal)
--                                         capped_all_usd = LEAST(fmv, ask) for every tier (the wider variant)
--   panini_fmv_ask_cap_shadow_snapshot()  daily writer (pg_cron rpc-panini-fmv-ask-cap-shadow), logs a pipeline run
--   panini_fmv_ask_cap_shadow_backtest(p_days)  scores each variant against the next marketplace sale: the
--                                       newest snapshot taken 1-3 days before the sale (out of sample), all rows
--                                       and only the rows a cap changed.
--
-- Ask source = panini_market_board.low_ask_usd (lowest ask whose serial was re-read in the last 7 days; the
-- same ask edition_live_ask uses for Panini since 20261020031908). FMV = the board's fmv_usd/confidence, i.e.
-- what the edition page shows. Engine label from the latest panini_fmv_snapshots row of the edition.
-- Measured before apply: the board read is 0.53 s for 35,153 rows with an ask.
--
-- Judge from ~10-28 (sales land 12-160 h after sold_at): select * from panini_fmv_ask_cap_shadow_backtest(7);
-- a cap that wins on the "changed" rows without losing on "all" is the 1.4.0 candidate.
--
-- anon-exec: revoked (panini_fmv_ask_cap_shadow_snapshot) — new writer fn; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: revoked (panini_fmv_ask_cap_shadow_backtest) — new reader fn; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   select cron.unschedule('rpc-panini-fmv-ask-cap-shadow');
--   drop function public.panini_fmv_ask_cap_shadow_backtest(integer);
--   drop function public.panini_fmv_ask_cap_shadow_snapshot();
--   drop table public.panini_fmv_ask_cap_shadow;

CREATE TABLE IF NOT EXISTS public.panini_fmv_ask_cap_shadow (
  snapshot_at      timestamptz NOT NULL,
  external_id      text        NOT NULL,
  fmv_usd          numeric     NOT NULL,
  confidence       text,
  algo_version     text,
  fmv_computed_at  timestamptz,
  live_ask_usd     numeric     NOT NULL,
  ask_confirmed_at timestamptz,
  capped_low_usd   numeric     NOT NULL,
  capped_all_usd   numeric     NOT NULL,
  PRIMARY KEY (snapshot_at, external_id)
);

ALTER TABLE public.panini_fmv_ask_cap_shadow ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.panini_fmv_ask_cap_shadow FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.panini_fmv_ask_cap_shadow TO service_role;

CREATE INDEX IF NOT EXISTS panini_fmv_ask_cap_shadow_ext_time
  ON public.panini_fmv_ask_cap_shadow (external_id, snapshot_at DESC);

COMMENT ON TABLE public.panini_fmv_ask_cap_shadow IS
  'Shadow log for known-issues #202 / panini-1.4.0: published Panini FMV beside the confirmed live ask and two capped candidates. Prices nothing. Score with panini_fmv_ask_cap_shadow_backtest(p_days). audit_20261021.';

CREATE OR REPLACE FUNCTION public.panini_fmv_ask_cap_shadow_snapshot()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  INSERT INTO public.panini_fmv_ask_cap_shadow
    (snapshot_at, external_id, fmv_usd, confidence, algo_version, fmv_computed_at,
     live_ask_usd, ask_confirmed_at, capped_low_usd, capped_all_usd)
  SELECT v_started, b.external_id::text, b.fmv_usd, b.confidence::text, v.algo_version, b.fmv_computed_at,
         b.low_ask_usd, b.ask_confirmed_at,
         CASE WHEN b.confidence::text = 'LOW' THEN LEAST(b.fmv_usd, b.low_ask_usd) ELSE b.fmv_usd END,
         LEAST(b.fmv_usd, b.low_ask_usd)
    FROM public.panini_market_board b
    LEFT JOIN LATERAL (
      SELECT x.algo_version
        FROM public.panini_editions pe
        JOIN public.panini_fmv_snapshots x ON x.edition_id = pe.id
       WHERE pe.external_id = b.external_id::text
       ORDER BY x.computed_at DESC
       LIMIT 1) v ON true
   WHERE b.low_ask_usd > 0 AND b.fmv_usd > 0
  ON CONFLICT (snapshot_at, external_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  PERFORM public.log_pipeline_run('panini-fmv-ask-cap-shadow', v_started, v_rows, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'no board rows with an ask and an FMV' END,
    'panini_blockchain', NULL, NULL, jsonb_build_object('known_issue', 202));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-fmv-ask-cap-shadow', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('known_issue', 202, 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.panini_fmv_ask_cap_shadow_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_fmv_ask_cap_shadow_snapshot() TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.panini_fmv_ask_cap_shadow_backtest(p_days integer DEFAULT 7)
 RETURNS TABLE(variant text, scope text, confidence text, n bigint, within_25_pct numeric,
               median_abs_err_pct numeric, median_ratio numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH s AS (
    SELECT ps.edition_external_id AS ext, ps.amount_usd AS p, ps.sold_at AS t
      FROM public.panini_sales ps
     WHERE ps.sale_kind = 'Marketplace' AND ps.amount_usd > 0
       AND ps.sold_at > now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 60)))
  ), j AS (
    SELECT s.p, sh.fmv_usd, sh.capped_low_usd, sh.capped_all_usd, sh.confidence
      FROM s
      CROSS JOIN LATERAL (
        SELECT x.* FROM public.panini_fmv_ask_cap_shadow x
         WHERE x.external_id = s.ext
           AND x.snapshot_at <  s.t - interval '1 day'
           AND x.snapshot_at >= s.t - interval '3 days'
         ORDER BY x.snapshot_at DESC
         LIMIT 1) sh
  ), long AS (
    SELECT 'published'::text AS variant, 'all'::text AS scope, confidence, fmv_usd AS est, p FROM j
    UNION ALL SELECT 'capped_low', 'all', confidence, capped_low_usd, p FROM j
    UNION ALL SELECT 'capped_all', 'all', confidence, capped_all_usd, p FROM j
    UNION ALL SELECT 'published', 'changed_by_low_cap', confidence, fmv_usd, p FROM j WHERE capped_low_usd < fmv_usd
    UNION ALL SELECT 'capped_low', 'changed_by_low_cap', confidence, capped_low_usd, p FROM j WHERE capped_low_usd < fmv_usd
    UNION ALL SELECT 'published', 'changed_by_all_cap', confidence, fmv_usd, p FROM j WHERE capped_all_usd < fmv_usd
    UNION ALL SELECT 'capped_all', 'changed_by_all_cap', confidence, capped_all_usd, p FROM j WHERE capped_all_usd < fmv_usd
  )
  SELECT variant, scope, COALESCE(confidence, 'ALL'), count(*),
         round(100.0 * avg(CASE WHEN abs(est / p - 1) <= 0.25 THEN 1 ELSE 0 END), 1),
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(est / p - 1)))::numeric * 100, 1),
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY est / p))::numeric, 3)
    FROM long
   GROUP BY variant, scope, ROLLUP(confidence)
   ORDER BY scope, COALESCE(confidence, 'ALL'), variant;
$function$;

REVOKE EXECUTE ON FUNCTION public.panini_fmv_ask_cap_shadow_backtest(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_fmv_ask_cap_shadow_backtest(integer) TO postgres, service_role;

-- Daily at 6:29 AM PT (13:29 UTC): after the overnight walks, off :00/:20/:40, the least-booked minute of six measured; the read is 0.5 s.
SELECT cron.schedule('rpc-panini-fmv-ask-cap-shadow', '29 13 * * *',
  $$select public.panini_fmv_ask_cap_shadow_snapshot()$$);
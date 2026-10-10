-- audit_20261010_panini_sales_analytics_reads_a_precomputed_payload
--
-- 2026-10-10 ~10:15 AM PT (Claude Code, Windows box; Trevor: "Keep going").
--
-- MEASURED: /panini-blockchain/analytics rendered "COULDN'T LOAD PANINI SALES … Sales analytics are
-- unavailable right now" in a 390 px mobile sweep, and production logged
-- "[panini/sales-analytics] read failed or timed out" at 10:04 AM PT (pdx1, a fresh deploy). The page
-- calls panini_sales_analytics(30) under a 10 s budget (lib/panini/sales-analytics-read.ts) and ISR
-- caches the result for 300 s, so one slow read is served to every visitor for five minutes.
-- EXPLAIN ANALYZE of panini_sales_analytics(30), warm: 3,805 ms, 285,448 shared-hit buffers plus a
-- temp spill (8,101 read / 8,105 written). Cold or under load it passes the budget.
--
-- CHANGE (the panini_sale_feed_status pattern, 20261010053847): refresh_panini_sales_analytics()
-- stores the 30-day payload in panini_sales_analytics_snapshot every 30 min (pg_cron
-- rpc-panini-sales-analytics-refresh, '2,32 * * * *' -- the lightest even-spaced minute pair by summed
-- cron_job_run_details seconds over 24 h). The page now calls panini_sales_analytics_cached(p_days),
-- which returns the stored payload ONLY while it is younger than 75 min (two missed ticks plus slack)
-- and otherwise computes LIVE exactly as before. panini_sales_analytics itself is unchanged.
--
-- HONESTY: a stale or missing snapshot is never served; a dead refresher degrades to today's
-- behaviour (slow but true), not to a frozen answer. The payload carries its own generated_at, so a
-- snapshot-served answer states its own age. Only p_days = 30 is stored; any other window is live.
-- The refresher has no exception handler on purpose: a failed or killed run raises, pg_cron records
-- it, nothing is written (the old row ages into the live fallback), and no ok=true is logged.
--
-- anon-exec: revoked (refresh_panini_sales_analytics) — new SECDEF writer; REVOKE FROM PUBLIC, anon, authenticated below, GRANT postgres + service_role.
-- anon-exec: revoked (panini_sales_analytics_cached) — new invoker reader; REVOKE FROM PUBLIC, anon, authenticated below, GRANT service_role (the page reads through supabaseAdmin), matching panini_sales_analytics.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-panini-sales-analytics-refresh');
--   (point lib/panini/sales-analytics-read.ts back at panini_sales_analytics first, then:)
--   DROP FUNCTION public.panini_sales_analytics_cached(integer);
--   DROP FUNCTION public.refresh_panini_sales_analytics();
--   DROP TABLE public.panini_sales_analytics_snapshot;

CREATE TABLE IF NOT EXISTS public.panini_sales_analytics_snapshot (
  days         integer     PRIMARY KEY CHECK (days > 0),
  payload      jsonb       NOT NULL,
  computed_at  timestamptz NOT NULL,
  duration_ms  integer     NOT NULL
);
ALTER TABLE public.panini_sales_analytics_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_sales_analytics_snapshot FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.panini_sales_analytics_snapshot IS
  'panini_sales_analytics(days) payloads written by refresh_panini_sales_analytics() every 30 min. panini_sales_analytics_cached() ignores a row older than 75 min.';

CREATE OR REPLACE FUNCTION public.refresh_panini_sales_analytics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_payload  jsonb;
  v_ms       integer;
BEGIN
  v_payload := public.panini_sales_analytics(30);
  IF v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'refresh_panini_sales_analytics: panini_sales_analytics(30) returned no object';
  END IF;
  v_ms := round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int;

  INSERT INTO public.panini_sales_analytics_snapshot AS t (days, payload, computed_at, duration_ms)
  VALUES (30, v_payload, clock_timestamp(), v_ms)
  ON CONFLICT (days) DO UPDATE
    SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;

  PERFORM public.log_pipeline_run('panini-sales-analytics-refresh', v_started,
    1, 1, 0, true, NULL, 'panini_blockchain', NULL, NULL,
    jsonb_build_object('days', 30, 'payload_bytes', length(v_payload::text), 'duration_ms', v_ms,
                       'window_sales', v_payload #> '{window,sales}'));

  RETURN jsonb_build_object('ok', true, 'days', 30, 'duration_ms', v_ms);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_sales_analytics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_sales_analytics() TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.panini_sales_analytics_cached(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  SELECT s.payload INTO v_payload
    FROM public.panini_sales_analytics_snapshot s
   WHERE s.days = p_days
     AND s.computed_at > now() - interval '75 minutes';
  IF v_payload IS NOT NULL THEN
    RETURN v_payload;
  END IF;
  RETURN public.panini_sales_analytics(p_days);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.panini_sales_analytics_cached(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_sales_analytics_cached(integer) TO service_role;

SELECT public.refresh_panini_sales_analytics();

SELECT cron.schedule('rpc-panini-sales-analytics-refresh', '2,32 * * * *',
                     'SELECT public.refresh_panini_sales_analytics();');

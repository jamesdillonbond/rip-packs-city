-- Follow-up to 20260920150414 (leg 324: per-year baseline + live year), applied minutes later.
-- Control run 08:06 AM PT through run_thp_leg_logged: the live slice (sold_at >= 2026-01-01)
-- ALONE took 480,149 ms (value 0, ok) — the 2026 partition holds most of the parallel-edition
-- sales, so "current year" is not a small slice; 480 s against a 600 s budget is a kill waiting
-- for the next spell. The grain moves from YEAR to MONTH: every closed month (2020-01 .. last
-- month) holds a baseline row; the leg counts only the CURRENT month live; the rotation refreshes
-- as many stalest months as fit a soft budget per run (420 s of a 600 s cron_heavy call, each
-- month its own query, oldest computed_at first), so a re-key in a closed month reaches the
-- baseline within a few days instead of six. A missing closed month ⇒ 999, as before.
--
-- Seed: every closed month 0 with the 09-19 5:48 PM PT full-read stamp (that read's total was 0,
-- so each month's count is 0 as of that measurement). The rotation replaces the seeds.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: jobid 324's 19:52Z (12:52 PM PT) tick succeeds with duration_ms < 60,000; the 19:22Z
--   rotation logs a thp-impossible-parallel-baseline row with months_refreshed ≥ 10 on 09-20/21;
--   `SELECT min(computed_at) FROM rpc_impossible_parallel_baseline` passes 09-21 within a week.
-- FALSIFIER: the current-month slice alone > 120 s ⇒ the month grain is still too coarse for
--   this partition's IO; go to weeks, do not touch the slot.
-- REVERT: re-apply 20260920150414 (year grain) — its table DDL, functions and seed.
--
-- anon-exec: intentional — helpers REVOKEd from PUBLIC, anon, authenticated below (cron_heavy + service_role only); the leg keeps its ACL, same signature (rpc_impossible_parallel_count, rpc_impossible_parallel_refresh_stalest_baseline, rpc_thp_leg_impossible_parallel)

DROP TABLE IF EXISTS public.rpc_impossible_parallel_baseline;
CREATE TABLE public.rpc_impossible_parallel_baseline (
  period_start date PRIMARY KEY,           -- first day of the month
  value        numeric NOT NULL,
  computed_at  timestamptz NOT NULL,
  duration_ms  integer,
  note         text
);
ALTER TABLE public.rpc_impossible_parallel_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rpc_impossible_parallel_baseline FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.rpc_impossible_parallel_baseline IS
  'Per-MONTH impossible-parallel-serial counts for every closed month since 2020-01, read by rpc_thp_leg_impossible_parallel (which counts only the current month live) and refreshed stalest-first inside a soft budget by rpc_impossible_parallel_refresh_stalest_baseline (pg_cron rpc-impossible-parallel-baseline-rotate, 19:22Z, cron_heavy). A missing closed month makes the leg publish 999. Month grain since 20260920 (year grain lasted one control run: the 2026 year alone was 480 s).';

-- rpc_impossible_parallel_count(p_from, p_to) is unchanged from 20260920150414.

CREATE OR REPLACE FUNCTION public.rpc_impossible_parallel_refresh_stalest_baseline(p_budget_seconds integer DEFAULT 420)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_month   date;
  v_value   numeric;
  v_t0      timestamptz;
  v_n       int := 0;
  v_ok      boolean := true;
  v_err     text := NULL;
  v_months  jsonb := '[]'::jsonb;
BEGIN
  -- Closed months = 2020-01 .. the month before the current one. A month with no row sorts
  -- first, then the oldest computed_at. One month per statement; stop when the soft budget is
  -- spent (the cron_heavy 600 s budget covers the whole call; 420 s leaves the log row room).
  LOOP
    EXIT WHEN clock_timestamp() - v_started > make_interval(secs => p_budget_seconds);
    SELECT m::date INTO v_month
    FROM generate_series('2020-01-01'::date, (date_trunc('month', now()) - interval '1 month')::date, interval '1 month') AS m
    LEFT JOIN public.rpc_impossible_parallel_baseline b ON b.period_start = m::date
    WHERE b.period_start IS NULL OR b.computed_at < v_started
    ORDER BY b.computed_at NULLS FIRST, m
    LIMIT 1;
    EXIT WHEN v_month IS NULL;   -- everything refreshed since this run began
    BEGIN
      v_t0 := clock_timestamp();
      v_value := public.rpc_impossible_parallel_count(v_month::timestamptz, (v_month + interval '1 month')::timestamptz);
      INSERT INTO public.rpc_impossible_parallel_baseline (period_start, value, computed_at, duration_ms, note)
      VALUES (v_month, v_value, now(), (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int, 'rotating refresh')
      ON CONFLICT (period_start) DO UPDATE
        SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at,
            duration_ms = EXCLUDED.duration_ms, note = EXCLUDED.note;
      v_n := v_n + 1;
      v_months := v_months || to_jsonb(v_month);
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      -- A kill leaves the previous row for that month (and its computed_at) in place.
      v_ok := false;
      v_err := SQLSTATE || ': ' || SQLERRM || ' (month ' || v_month || ')';
      EXIT;
    END;
  END LOOP;

  PERFORM public.log_pipeline_run('thp-impossible-parallel-baseline', v_started, v_n, v_n, 0, v_ok, v_err,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('months_refreshed', v_n, 'months', v_months, 'via', 'pg_cron',
                       'budget_seconds', p_budget_seconds,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('months_refreshed', v_n, 'ok', v_ok, 'error', v_err);
END;
$function$;
DROP FUNCTION IF EXISTS public.rpc_impossible_parallel_refresh_stalest_baseline();
REVOKE EXECUTE ON FUNCTION public.rpc_impossible_parallel_refresh_stalest_baseline(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_impossible_parallel_refresh_stalest_baseline(integer) TO cron_heavy, service_role;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '480s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric; v_base numeric; v_months int; v_want int;
BEGIN
  BEGIN
    -- Every closed month (2020-01 .. last month) must have a baseline row, or the arm is
    -- unmeasured (999) — never a partial sum published as the whole.
    v_want := (extract(year FROM now())::int - 2020) * 12 + extract(month FROM now())::int - 1;
    SELECT count(*), coalesce(sum(b.value), 0) INTO v_months, v_base
    FROM public.rpc_impossible_parallel_baseline b
    WHERE b.period_start >= '2020-01-01' AND b.period_start < date_trunc('month', now())::date;
    IF v_months <> v_want THEN
      RAISE EXCEPTION 'impossible-parallel baseline incomplete: % of % closed months', v_months, v_want;
    END IF;
    v := v_base + public.rpc_impossible_parallel_count(date_trunc('month', now()), '2100-01-01'::timestamptz);
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- Seed every closed month with 0 from the 09-19 5:48 PM PT full read (total 0 over all history).
INSERT INTO public.rpc_impossible_parallel_baseline (period_start, value, computed_at, duration_ms, note)
SELECT m::date, 0, '2026-09-20 00:48:00+00'::timestamptz, NULL,
       'seeded 2026-09-20 from the 09-19 5:48 PM PT full read (272 s, total 0); replaced by the rotation'
FROM generate_series('2020-01-01'::date, (date_trunc('month', now()) - interval '1 month')::date, interval '1 month') AS m
ON CONFLICT (period_start) DO NOTHING;

-- The rotation job keeps its name/slot; the command gains the explicit budget.
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('rpc-impossible-parallel-baseline-rotate', '22 19 * * *',
  'SELECT public.rpc_impossible_parallel_refresh_stalest_baseline(420);');
RESET ROLE;

DO $$
DECLARE v_src text; v_n int; v_want int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.rpc_thp_leg_impossible_parallel()'::regprocedure;
  IF strpos(v_src, 'closed months') = 0 THEN RAISE EXCEPTION 'leg is not on the month grain'; END IF;
  v_want := (extract(year FROM now())::int - 2020) * 12 + extract(month FROM now())::int - 1;
  SELECT count(*) INTO v_n FROM public.rpc_impossible_parallel_baseline;
  IF v_n <> v_want THEN RAISE EXCEPTION 'baseline seed: % rows, wanted %', v_n, v_want; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-impossible-parallel-baseline-rotate' AND username = 'cron_heavy') <> 1 THEN
    RAISE EXCEPTION 'rotation job missing';
  END IF;
  IF has_function_privilege('anon', 'public.rpc_impossible_parallel_refresh_stalest_baseline(integer)', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (refresh)'; END IF;
  IF has_function_privilege('anon', 'public.rpc_thp_leg_impossible_parallel()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (leg)'; END IF;
END $$;

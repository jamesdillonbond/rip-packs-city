-- Follow-up to 20260920151857, caught by its own pin test before any prod tick ran the rotation:
-- rpc_impossible_parallel_refresh_stalest_baseline stamped computed_at = now() (the TRANSACTION
-- start) while its "already refreshed this run" test compared against v_started =
-- clock_timestamp() (function start, later by microseconds), so every month it wrote read as
-- still stale and the loop re-refreshed the same stalest month until the budget expired (the
-- pin measured 9,074 refreshes where 80 were expected). Stamp clock_timestamp() instead — the
-- write time is the honest computed_at anyway. Body otherwise unchanged. The 19:22Z job would
-- have spent 420 s on 2020-01 alone.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
-- REVERT: n/a (a bug fix on a function that had not yet run in prod).
--
-- anon-exec: intentional — same signature, existing ACL preserved (cron_heavy + service_role only) (rpc_impossible_parallel_refresh_stalest_baseline)

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
  -- computed_at is stamped with clock_timestamp(), never now(): now() is the transaction start
  -- and sorts BEFORE v_started, which made every freshly written month read as stale again.
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
      VALUES (v_month, v_value, clock_timestamp(), (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int, 'rotating refresh')
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

DO $$
BEGIN
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.rpc_impossible_parallel_refresh_stalest_baseline(integer)'::regprocedure), 'VALUES (v_month, v_value, clock_timestamp()') = 0 THEN
    RAISE EXCEPTION 'clock_timestamp stamp missing';
  END IF;
  IF has_function_privilege('anon', 'public.rpc_impossible_parallel_refresh_stalest_baseline(integer)', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
END $$;

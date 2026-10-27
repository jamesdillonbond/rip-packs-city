-- audit_20261026: refresh_allday_hot_floors_snapshot records a statement_timeout kill too (fix to 20261027031715).
-- `EXCEPTION WHEN OTHERS` does not catch 57014 (R118), so a killed refresh would have left no failed run on record.
-- Caught by __tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts before push.
-- anon-exec: unchanged (refresh_allday_hot_floors_snapshot) — CREATE OR REPLACE; ACL preserved (has_function_privilege anon = false, read 2026-10-26 ~8:25 PM PT).
--
-- Revert: re-apply the function body from 20261027031715.

CREATE OR REPLACE FUNCTION public.refresh_allday_hot_floors_snapshot()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_payload jsonb;
  v_n int;
BEGIN
  v_payload := public.get_allday_hot_floors(7);
  v_n := COALESCE(jsonb_array_length(v_payload->'editions'), 0);
  INSERT INTO public.allday_hot_floors_snapshot (id, payload, computed_at)
  VALUES (1, v_payload, clock_timestamp())
  ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
  PERFORM public.log_pipeline_run('allday-hot-floors-snapshot', v_started, v_n, v_n, 0, true, NULL, 'nfl_all_day', NULL, NULL,
    jsonb_build_object('duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- The previous snapshot stays (with its own computed_at); this run is recorded as failed — including a
  -- statement_timeout kill (57014), which WHEN OTHERS alone cannot see (R118).
  PERFORM public.log_pipeline_run('allday-hot-floors-snapshot', v_started, 0, 0, 0, false, SQLERRM, 'nfl_all_day', NULL, NULL, NULL);
END;
$function$;

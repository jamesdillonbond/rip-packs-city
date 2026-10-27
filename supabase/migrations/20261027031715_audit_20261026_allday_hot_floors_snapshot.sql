-- audit_20261026: /nfl-all-day/hot-floors reads a 15-minute snapshot instead of computing on the read path.
--
-- The daytime monitor (inbox 2026-10-27 ~03:09Z) saw the first renders after the parity deploy hit the 8 s read
-- bound on all three Hot Floors boards (All Day, Panini, Top Shot) in the same minute. get_allday_hot_floors measured
-- 34 ms warm but 5.1 s cold; a cold cache plus concurrent first renders crosses 8 s, and on a 300 s ISR page that
-- failed (honest "Couldn't load") render can be served until the next regeneration. The board now reads one row.
-- First refresh 10-26 ~8:17 PM PT: 50 editions, 552 ms, logged ok. Slot 8,23,38,53 measured among the quieter
-- minutes (2-day busy cron-seconds: :08 3,956 · :53 3,912 · :23 5,233 · :38 4,572). On a failed refresh the previous
-- snapshot stays with its own computed_at, which the page shows ("Board updated N ago").
--
-- Revert: SELECT cron.unschedule('allday-hot-floors-snapshot');
--         DROP FUNCTION public.refresh_allday_hot_floors_snapshot(); DROP TABLE public.allday_hot_floors_snapshot;
--         (the page then computes live again — lib/hot-floors/allday.ts falls back when no row exists)

CREATE TABLE IF NOT EXISTS public.allday_hot_floors_snapshot (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.allday_hot_floors_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.allday_hot_floors_snapshot FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_hot_floors_snapshot TO service_role;

-- anon-exec: revoked (refresh_allday_hot_floors_snapshot) — pg_cron writer; REVOKE FROM PUBLIC, anon, authenticated below.
-- when-others-timeout-blind: intentional — kept as APPLIED; superseded minutes later by 20261027032544 (…_sees_timeout), which names query_canceled.
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
EXCEPTION WHEN OTHERS THEN
  -- The previous snapshot stays (with its own computed_at); this run is recorded as failed.
  -- ⚠ (R118) a statement_timeout kill (57014) is not caught here — pg_cron's job_run_details records it.
  PERFORM public.log_pipeline_run('allday-hot-floors-snapshot', v_started, 0, 0, 0, false, SQLERRM, 'nfl_all_day', NULL, NULL, NULL);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.refresh_allday_hot_floors_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_allday_hot_floors_snapshot() TO postgres, service_role;

COMMENT ON TABLE public.allday_hot_floors_snapshot IS
  'One row: get_allday_hot_floors(7) precomputed every 15 min (pg_cron allday-hot-floors-snapshot, 8,23,38,53). /nfl-all-day/hot-floors reads this instead of computing on the read path (the first cold renders hit the 8 s read bound, 10-26). audit_20261026.';

SELECT cron.schedule('allday-hot-floors-snapshot', '8,23,38,53 * * * *', $$SELECT public.refresh_allday_hot_floors_snapshot()$$);
SELECT public.refresh_allday_hot_floors_snapshot();

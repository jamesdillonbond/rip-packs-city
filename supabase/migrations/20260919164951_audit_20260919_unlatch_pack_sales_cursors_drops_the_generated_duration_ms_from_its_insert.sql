-- audit_20260919_unlatch_pack_sales_cursors_drops_the_generated_duration_ms
--
-- Fixes the body shipped minutes earlier in
-- `audit_20260919_pack_sales_cursors_self_heal_from_the_done_latch...`, whose
-- INSERT listed `duration_ms`. That column is GENERATED on `pipeline_runs`, so
-- every call raised `428C9 cannot insert a non-DEFAULT value into column
-- "duration_ms"`. Caught by RUNNING the function before scheduling it -- the
-- creating migration reported success, because a plpgsql body is not planned
-- until it executes. Full rationale for the function stays in that migration.
--
-- ⭐ THE LESSON, and it generalises past this function: `apply_migration`
-- returning success proves the function was CREATED, never that it RUNS. For any
-- plpgsql body, execute it once before wiring a scheduler to it -- otherwise the
-- first evidence is a pg_cron failure nobody is watching, which is the exact
-- failure mode this whole pair of migrations exists to remove.
--
-- REVERT: as that migration.

CREATE OR REPLACE FUNCTION public.unlatch_pack_sales_cursors(p_latched_minutes integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts_reset  int := 0;
  v_ad_reset  int := 0;
  v_ts_done   boolean;
  v_ad_done   boolean;
  v_ts_cur_at timestamptz;
  v_ad_cur_at timestamptz;
  v_ts_newest timestamptz;
  v_ad_newest timestamptz;
  v_extra     jsonb;
BEGIN
  -- Read state BEFORE the update so the recorded row says what it found, not
  -- what it left behind. (`was_latched` is the whole point of the record.)
  SELECT done, updated_at INTO v_ts_done, v_ts_cur_at
    FROM public.topshot_pack_sales_cursor WHERE id = 1;
  SELECT done, updated_at INTO v_ad_done, v_ad_cur_at
    FROM public.allday_pack_sales_cursor WHERE id = 1;

  UPDATE public.topshot_pack_sales_cursor
     SET after_cursor = NULL, done = false, total_seen = 0, updated_at = now()
   WHERE id = 1
     AND done
     AND updated_at < now() - make_interval(mins => p_latched_minutes);
  GET DIAGNOSTICS v_ts_reset = ROW_COUNT;

  UPDATE public.allday_pack_sales_cursor
     SET after_cursor = NULL, done = false, total_seen = 0, updated_at = now()
   WHERE id = 1
     AND done
     AND updated_at < now() - make_interval(mins => p_latched_minutes);
  GET DIAGNOSTICS v_ad_reset = ROW_COUNT;

  -- Indexed one-row backward scans; see the creating migration for why this
  -- reads `block_time` and NOT `ingested_at` (no index -> ~45 GB/day).
  SELECT max(block_time) INTO v_ts_newest FROM public.topshot_pack_sales_history;
  SELECT max(block_time) INTO v_ad_newest FROM public.allday_pack_sales_history;

  v_extra := jsonb_build_object(
    'latched_minutes', p_latched_minutes,
    'topshot', jsonb_build_object(
      'was_latched',        coalesce(v_ts_done, false),
      'reset',              v_ts_reset,
      'cursor_updated_at',  v_ts_cur_at,
      'newest_sale_at',     v_ts_newest,
      'sale_age_hours',     round((extract(epoch FROM (now() - v_ts_newest))/3600)::numeric, 1)
    ),
    'allday', jsonb_build_object(
      'was_latched',        coalesce(v_ad_done, false),
      'reset',              v_ad_reset,
      'cursor_updated_at',  v_ad_cur_at,
      'newest_sale_at',     v_ad_newest,
      'sale_age_hours',     round((extract(epoch FROM (now() - v_ad_newest))/3600)::numeric, 1)
    )
  );

  -- `ok` is the ACTION's outcome, never the lane's health -- overloading it is
  -- the `rows_written = 0` trap one level up. Staleness lives in `extra`, where
  -- a reader has to look at `sale_age_hours` deliberately.
  -- ⚠ `duration_ms` is GENERATED on pipeline_runs -- never name it here.
  INSERT INTO public.pipeline_runs
    (pipeline, started_at, finished_at, rows_found, rows_written, ok, extra)
  VALUES
    ('pack-sales-cursor-unlatch', v_started, clock_timestamp(),
     v_ts_reset + v_ad_reset, v_ts_reset + v_ad_reset, true, v_extra);

  RETURN v_extra;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.unlatch_pack_sales_cursors(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unlatch_pack_sales_cursors(integer) TO postgres, service_role;

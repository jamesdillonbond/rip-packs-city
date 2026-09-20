-- 2026-09-19 (PT) / 2026-09-20 UTC — an instrument for #126, because its only VALID
-- test cannot currently be run.
--
-- WHY THIS EXISTS
-- ---------------
-- #126 asks whether the fleet's ~10x slowdown at constant work is explained by
-- `net._http_response` carrying ~10 GB of dead TOAST. The one-shot 09-20 test that
-- both the evening handoff and the register first proposed ("did the 02-18Z band
-- return?") is CONFOUNDED: sixteen migrations landed between 00:16Z and 02:44Z on
-- 09-20, at least ten of them moving load in both directions. The register already
-- records that correction and names the replacement test:
--
--     `20260920020934` installs the VACUUM FULL weekly, so the store will climb and
--     be reclaimed again on a known schedule. A SAWTOOTH in busy-seconds locked to
--     that cadence is attributable; a single coincidence is not.
--
-- That test needs two series over several weeks. Neither is persisted anywhere:
--   * `cron.job_run_details` retains 31 days and is then gone, and
--   * the store's size is persisted NOWHERE, which is why 09-14's 13.5 GB figure had
--     to be quoted out of the register rather than read off an instrument.
-- So the register's own instruction — "record the store's size alongside busy-seconds
-- from now on" — is what this migration does.
--
-- WHY `pipeline_runs` AND NOT A NEW TABLE
-- ---------------------------------------
-- `pipeline_runs` is pruned at ~73h, but `rollup_pipeline_runs()` folds it into
-- `pipeline_runs_daily` (indefinite) and that table carries `extra_num_sums`: the
-- SUM of every NUMERIC key in `extra`, per pipeline per UTC day. A pipeline that
-- writes exactly ONE row per UTC day therefore has sum == value, and the series is
-- preserved for free by machinery that already exists and is already verified.
--
-- ⚠ THE ONCE-PER-DAY GUARD BELOW IS LOAD-BEARING, NOT TIDINESS. It is what makes
-- `extra_num_sums` READ AS A VALUE. A second row on the same UTC day — a retry, a
-- hand-dispatch — would silently DOUBLE every figure in the archive, and the archive
-- is the only copy once the raw rows are pruned.
--
-- HONESTY
-- -------
-- Each read is in its own exception block, and a read that fails OMITS ITS KEY and
-- sets ok=false with the message. It never writes a 0: a fabricated zero here would
-- read as "the store was empty that day" / "the fleet did no work that day", which is
-- exactly the defect class CLAUDE.md names. `rows_written` counts the metrics that
-- were ACTUALLY recorded, so a partial day is visible as a number, not just a flag.

create or replace function public.record_instance_load_series()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_today   date := (now() AT TIME ZONE 'UTC')::date;
  v_prev    date := (now() AT TIME ZONE 'UTC')::date - 1;
  v_extra   jsonb := jsonb_build_object('prev_utc_day', v_prev::text);
  v_ok      boolean := true;
  v_errs    text[] := '{}';
  v_bytes   bigint;
  v_rows    bigint;
  v_db      bigint;
  v_busy    numeric;
  v_runs    bigint;
  v_written int;
BEGIN
  -- ONE ROW PER UTC DAY. See the header: this identity is what makes the daily
  -- rollup's SUM equal the value rather than a multiple of it.
  IF EXISTS (
    SELECT 1 FROM public.pipeline_runs
    WHERE pipeline = 'ops-instance-load-series'
      AND (started_at AT TIME ZONE 'UTC')::date = v_today
  ) THEN
    RETURN jsonb_build_object(
      'skipped', true,
      'reason',  'a row for this UTC day already exists',
      'day',     v_today
    );
  END IF;

  -- The subject of #126's replacement test: the store that is reclaimed weekly.
  BEGIN
    SELECT pg_total_relation_size('net._http_response') INTO STRICT v_bytes;
    v_extra := v_extra || jsonb_build_object('pgnet_store_bytes', v_bytes);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_errs := v_errs || ('pgnet_store_bytes: ' || SQLERRM);
  END;

  BEGIN
    SELECT count(*) INTO STRICT v_rows FROM net._http_response;
    v_extra := v_extra || jsonb_build_object('pgnet_live_rows', v_rows);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_errs := v_errs || ('pgnet_live_rows: ' || SQLERRM);
  END;

  -- Context for the ratio the register keeps having to re-derive by hand.
  BEGIN
    SELECT pg_database_size(current_database()) INTO STRICT v_db;
    v_extra := v_extra || jsonb_build_object('db_size_bytes', v_db);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_errs := v_errs || ('db_size_bytes: ' || SQLERRM);
  END;

  -- #126's headline series. Bounded to the PREVIOUS COMPLETE UTC day, so the figure
  -- is never a partial day that would read as a drop. Measured cost 2026-09-20:
  -- 23,199 buffers / 933 ms (seq scan; job_run_details has no index on start_time) --
  -- once a day, against an estate doing ~200k busy-seconds a day.
  BEGIN
    SELECT count(*), sum(extract(epoch FROM (end_time - start_time)))
      INTO STRICT v_runs, v_busy
    FROM cron.job_run_details
    WHERE start_time >= v_prev::timestamptz
      AND start_time <  v_today::timestamptz;
    v_extra := v_extra || jsonb_build_object(
      'cron_runs_prev_utc_day', v_runs,
      'cron_busy_seconds_prev_utc_day', round(coalesce(v_busy, 0), 1)
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_errs := v_errs || ('cron_prev_utc_day: ' || SQLERRM);
  END;

  SELECT count(*)::int INTO v_written
  FROM jsonb_each(v_extra) WHERE jsonb_typeof(value) = 'number';

  -- duration_ms is GENERATED on pipeline_runs -- never list it.
  INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, rows_written, ok, error, extra)
  VALUES (
    'ops-instance-load-series', v_started, clock_timestamp(),
    v_written, v_ok,
    CASE WHEN v_ok THEN NULL ELSE array_to_string(v_errs, ' | ') END,
    v_extra
  );

  RETURN jsonb_build_object(
    'day', v_today, 'ok', v_ok, 'metrics_recorded', v_written, 'extra', v_extra
  );
END;
$function$;

-- ⚠ Both halves in ONE statement: either alone leaves a grant (PUBLIC default AND
-- ALTER DEFAULT PRIVILEGES), and the REVOKE orphans a pg_cron caller holding no
-- explicit grant -- which fails as SILENCE.
revoke all on function public.record_instance_load_series() from public, anon, authenticated;
grant execute on function public.record_instance_load_series() to postgres;

comment on function public.record_instance_load_series() is
  'Writes ONE pipeline_runs row per UTC day (pipeline ops-instance-load-series) carrying the pg_net store size and the previous complete UTC day''s cron busy-seconds, so #126''s weekly-sawtooth test has a series that survives job_run_details'' 31-day retention. The once-per-day guard is load-bearing: it is what makes pipeline_runs_daily.extra_num_sums read as a value rather than a multiple.';

-- 00:19Z: minutes 18/19/21/22 carry no other job in hour 0 (measured, not guessed).
-- No SET prefix -- that would make the command a transaction block.
select cron.schedule(
  'ops-instance-load-series',
  '19 0 * * *',
  'SELECT public.record_instance_load_series();'
);

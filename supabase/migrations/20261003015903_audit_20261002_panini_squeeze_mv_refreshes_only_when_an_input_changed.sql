-- 2026-10-02 (PT) — refresh_panini_squeeze() refreshes mv_panini_squeeze only when an input has
-- changed since the last refresh (or the last refresh is older than 6 h); an idle tick logs a
-- skip row instead of rebuilding 5,182 rows from a 1.5 GB table.
--
-- WHY (Trevor: "do what you think is best"). `rpc-refresh-panini-squeeze` runs 18,48 * * * *
-- (48/day, 8.4 s avg, ~70 k buffers after 20261003012400) while every one of its inputs lands
-- on the residential box's 4-hourly walks: today's `panini_card_serials.captured_at` /
-- `panini_editions.updated_at` / `panini_fmv_snapshots.computed_at` maxima all read
-- 2026-10-02 17:57:45Z (10:57 AM PT) and the walk hours in the last 24 h were 18, 19, 07, 08,
-- 09, 10 — so the 16 refreshes since 10:57 AM rebuilt an identical 5,182-row MV each time.
-- A cadence cut (hourly, 4-hourly) would trade freshness for cost blindly; a GATE keeps the
-- 30-minute freshness whenever the walks DO land and costs ~1 k buffers (four index-backed
-- maxima + one 629-page scan of panini_editions) when they do not.
--
-- WHAT. Watermark = `started_at` of the last ok, non-skipped `panini-squeeze-mv` run
-- (pipeline_runs, (pipeline, started_at) index; 73 h retention is far longer than the 6 h
-- bound). Inputs = greatest(max(serials.captured_at), max(serials.last_sale_at),
-- max(editions.updated_at), max(editions.last_seen_at), max(panini_fmv_snapshots.computed_at))
-- — every column the MV's SELECT reads moves one of these (serial nft_type/last_sale_usd arrive
-- with captured_at/last_sale_at; edition counts and asks with updated_at; FMV with computed_at).
-- `panini_coverage_audit` has no timestamp and changes by hand; the 6 h forced refresh bounds
-- that. Refresh when inputs > watermark, or watermark is NULL, or watermark < now() - 6 h;
-- otherwise log `{skipped: true, reason, inputs_max, last_refresh_started}` with
-- rows_found = the MV's current row count and rows_written = 0 (so `check_zero_yield_lanes`,
-- which keys on rows_found, still sees yield, and a reader can tell "skipped" from "wrote 0").
-- The watermark is the refresh's START, so an input written during a refresh is newer than
-- it and triggers the next tick — conservative by construction.
--
-- Same signature (RETURNS void), SECURITY INVOKER, owner postgres, called by pg_cron job 353
-- as postgres with `SET statement_timeout = '300s'`. Not pinned.
--
-- Positive control inside this migration: one call now, with inputs 10:57 AM < last refresh
-- 6:48 PM, must log a skip row (asserted on the row it writes). The forced-by-age branch is
-- exercised by production the first time the box sleeps > 6 h (it did last night: no walk
-- 7:49 PM → 7:07 AM).
--
-- Revert: re-apply the body from 20260822222305 (unconditional REFRESH).

-- anon-exec: unchanged (refresh_panini_squeeze) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false authenticated=false 2026-10-02.
CREATE OR REPLACE FUNCTION public.refresh_panini_squeeze()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
  v_last    timestamptz;
  v_inputs  timestamptz;
  v_forced  boolean;
BEGIN
  -- 2026-10-02: refresh only when an input moved since the last refresh, or the last refresh
  -- is older than 6 h. The inputs are every column mv_panini_squeeze reads, by the timestamp
  -- each of them arrives with.
  SELECT max(r.started_at) INTO v_last
    FROM public.pipeline_runs r
   WHERE r.pipeline = 'panini-squeeze-mv' AND r.ok
     AND coalesce((r.extra->>'skipped')::boolean, false) = false;
  v_inputs := greatest(
    (SELECT max(captured_at)  FROM public.panini_card_serials),
    (SELECT max(last_sale_at) FROM public.panini_card_serials),
    (SELECT max(updated_at)   FROM public.panini_editions),
    (SELECT max(last_seen_at) FROM public.panini_editions),
    (SELECT max(computed_at)  FROM public.panini_fmv_snapshots));
  v_forced := v_last IS NULL OR v_last < now() - interval '6 hours';

  IF NOT v_forced AND v_inputs IS NOT NULL AND v_inputs <= v_last THEN
    SELECT count(*) INTO v_rows FROM public.mv_panini_squeeze;
    PERFORM public.log_pipeline_run(
      p_pipeline     := 'panini-squeeze-mv',
      p_started_at   := v_started,
      p_rows_found   := v_rows,
      p_rows_written := 0,
      p_ok           := true,
      p_extra        := jsonb_build_object(
        'skipped', true,
        'reason', 'inputs unchanged since last refresh',
        'inputs_max', v_inputs,
        'last_refresh_started', v_last,
        'gate_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
        'mv', 'mv_panini_squeeze'
      )
    );
    RETURN;
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_squeeze;
  SELECT count(*) INTO v_rows FROM public.mv_panini_squeeze;
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'panini-squeeze-mv',
    p_started_at   := v_started,
    p_rows_found   := v_rows,
    p_rows_written := v_rows,
    p_ok           := true,
    p_extra        := jsonb_build_object(
      'refresh_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'mv', 'mv_panini_squeeze',
      'inputs_max', v_inputs,
      'last_refresh_started', v_last,
      'forced_by_age', v_forced
    )
  );
END;
$function$;

-- Positive control: with inputs older than the last refresh, one call must log a skip row.
DO $$
DECLARE
  v_before bigint;
  v_row record;
BEGIN
  IF has_function_privilege('anon', 'public.refresh_panini_squeeze()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refresh_panini_squeeze()', 'EXECUTE') THEN
    RAISE EXCEPTION 'refresh_panini_squeeze: anon/authenticated EXECUTE appeared';
  END IF;
  SELECT count(*) INTO v_before FROM public.pipeline_runs WHERE pipeline = 'panini-squeeze-mv';
  PERFORM public.refresh_panini_squeeze();
  SELECT * INTO v_row FROM public.pipeline_runs WHERE pipeline = 'panini-squeeze-mv' ORDER BY started_at DESC LIMIT 1;
  IF (SELECT count(*) FROM public.pipeline_runs WHERE pipeline = 'panini-squeeze-mv') <> v_before + 1 THEN
    RAISE EXCEPTION 'control: the call did not log exactly one run';
  END IF;
  IF v_row.extra->>'skipped' IS DISTINCT FROM 'true' THEN
    -- Not an error if an input genuinely moved in the last minutes; say which branch ran.
    RAISE NOTICE 'control: the call REFRESHED (inputs_max % > last refresh % or forced %)', v_row.extra->>'inputs_max', v_row.extra->>'last_refresh_started', v_row.extra->>'forced_by_age';
  ELSE
    IF v_row.rows_written <> 0 OR v_row.rows_found <= 0 THEN
      RAISE EXCEPTION 'control: skip row must carry rows_written 0 and the MV count in rows_found (got %, %)', v_row.rows_written, v_row.rows_found;
    END IF;
    RAISE NOTICE 'control ok: skipped in % ms, inputs_max %, last refresh %', v_row.extra->>'gate_ms', v_row.extra->>'inputs_max', v_row.extra->>'last_refresh_started';
  END IF;
END $$;

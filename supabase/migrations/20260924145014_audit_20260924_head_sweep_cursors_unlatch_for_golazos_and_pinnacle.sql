-- audit_20260924_head_sweep_cursors_unlatch_for_golazos_and_pinnacle (known-issues #135, partial)
--
-- WHY: the head-first walker (supabase/functions/_shared/head-sweep-walker.ts)
-- walks at most `headPages` pages from the head and stops at the first
-- all-known page; once the history sweep latches `done=true` the sweep leg is
-- skipped. A backlog larger than one head budget (an outage, a drop burst) then
-- leaves a GAP that no later run reaches, while every run reports ok=true.
-- `unlatch_pack_sales_cursors` (job 526) covers Top Shot + All Day only; the
-- three newer lanes had no path back:
--   golazos_pack_sales_cursor   (latched at review, job 597)
--   golazos_pack_opens_cursor   (sweep finishing, job 600)
--   pinnacle_pack_opens_cursor  (latched, job 605)
--
-- WHAT: a sibling of unlatch_pack_sales_cursors over those three cursors, same
-- reset (after_cursor NULL, done false, total_seen 0), recorded as pipeline
-- 'head-sweep-cursor-unlatch'. Default latch age is 360 min, not 30: these
-- lanes are smaller and slower, so a full re-sweep every ~6 h bounds a gap's
-- life at ~6 h + one sweep instead of forever, without re-walking the whole
-- API history every half hour. A re-sweep only re-reads pages: the walker's key
-- probe counts only rows that did not exist, so a repeat pass writes 0 new.
--
-- NOT DONE HERE (still #135): a `head_budget_exhausted` signal in the walker so
-- a gap is VISIBLE, and the Golazos pack-sales totalCount question.
--
-- REVERT: SELECT cron.unschedule('rpc-head-sweep-cursor-unlatch');
--         DROP FUNCTION public.unlatch_head_sweep_cursors(integer);

CREATE OR REPLACE FUNCTION public.unlatch_head_sweep_cursors(p_latched_minutes integer DEFAULT 360)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_tbl     text;
  v_done    boolean;
  v_cur_at  timestamptz;
  v_seen    bigint;
  v_reset   int;
  v_total   int := 0;
  v_extra   jsonb := jsonb_build_object('latched_minutes', p_latched_minutes);
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['golazos_pack_sales_cursor',
                               'golazos_pack_opens_cursor',
                               'pinnacle_pack_opens_cursor'] LOOP
    -- Read BEFORE the update so the record says what it found.
    EXECUTE format('SELECT done, updated_at, total_seen FROM public.%I WHERE id = 1', v_tbl)
      INTO v_done, v_cur_at, v_seen;
    EXECUTE format(
      'UPDATE public.%I SET after_cursor = NULL, done = false, total_seen = 0, updated_at = now()
        WHERE id = 1 AND done AND updated_at < now() - make_interval(mins => $1)', v_tbl)
      USING p_latched_minutes;
    GET DIAGNOSTICS v_reset = ROW_COUNT;
    v_total := v_total + v_reset;
    v_extra := v_extra || jsonb_build_object(v_tbl, jsonb_build_object(
      'was_latched',       coalesce(v_done, false),
      'reset',             v_reset,
      'cursor_updated_at', v_cur_at,
      'total_seen_before', v_seen));
  END LOOP;

  -- `ok` is the ACTION's outcome, never the lanes' health.
  -- ⚠ `duration_ms` is GENERATED on pipeline_runs -- never name it here.
  INSERT INTO public.pipeline_runs
    (pipeline, started_at, finished_at, rows_found, rows_written, ok, extra)
  VALUES
    ('head-sweep-cursor-unlatch', v_started, clock_timestamp(), v_total, v_total, true, v_extra);

  RETURN v_extra;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.unlatch_head_sweep_cursors(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unlatch_head_sweep_cursors(integer) TO postgres, service_role;

SELECT cron.schedule('rpc-head-sweep-cursor-unlatch', '29 * * * *',
                     'SELECT public.unlatch_head_sweep_cursors(360);');
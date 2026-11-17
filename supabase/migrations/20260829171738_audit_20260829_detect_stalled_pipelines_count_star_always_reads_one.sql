-- audit_20260829_detect_stalled_pipelines_count_star_always_reads_one
--
-- Metadata only. APPENDS to the comment on public.detect_stalled_pipelines().
-- No signature change, no grants, no behaviour, no data.
--
-- REVERT (truncates back to exactly the pre-migration 431-char text):
--   DO $r$ DECLARE c text; BEGIN
--     SELECT obj_description('public.detect_stalled_pipelines()'::regprocedure,'pg_proc') INTO c;
--     EXECUTE format('COMMENT ON FUNCTION public.detect_stalled_pipelines() IS %L', left(c, 431));
--   END $r$;

DO $mig$
DECLARE
  v_oid  oid := 'public.detect_stalled_pipelines()'::regprocedure::oid;
  v_old  text;
  v_new  text;
  v_read text;
  c_md5  constant text := 'b3f49a5903f11b72d6fd28b7ec735207';
  c_len  constant int  := 431;
BEGIN
  SET LOCAL lock_timeout = '5s';

  v_old := obj_description(v_oid, 'pg_proc');
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: the function carries no comment';
  END IF;
  IF length(v_old) <> c_len OR md5(v_old) <> c_md5 THEN
    RAISE EXCEPTION
      'PRE-STATE FAILED: comment changed (len % md5 %, expected % / %) -- re-read before appending',
      length(v_old), md5(v_old), c_len, c_md5;
  END IF;

  v_new := v_old || '

*** 2026-08-29 17:1xZ -- INSTRUMENT TRAP, AND IT HAS ALREADY INVERTED A HEALTH VERDICT. ***
THIS FUNCTION RETURNS ONE ROW CONTAINING A jsonb ARRAY (pg_get_function_result = jsonb), so
"SELECT count(*) FROM public.detect_stalled_pipelines()" READS 1 WHETHER 1, 4 OR 40 PIPELINES ARE
STALLED -- and it reads 1 when ZERO are stalled too, because an empty array is still one row.
A count-based read of this arm is meaningless in BOTH directions.

READ IT AS A VALUE, e.g.
    SELECT jsonb_array_length(public.detect_stalled_pipelines());          -- the count
    SELECT x FROM jsonb_array_elements(public.detect_stalled_pipelines()) x;  -- the rows

MEASURED CONSEQUENCE, so this is not a hypothetical: the 2026-08-29 15:15Z Cowork handoff recorded
"detect_stalled_pipelines() -- 1 -- panini-ingest only" and passed the health sweep on it. Read as a
VALUE at 17:15Z the same day the array held FOUR entries: weekly-db-maintenance (1,882 min vs
1,800), panini-ingest (921 vs 360), allday-pack-opens-backfill (200 vs 90) and
refresh-pack-grail-metrics-mv (113 vs 90). The 09:35Z pass, which wrote "array length 2", had it
right. ⛔ Do not compare a count-derived number from one handoff with a length-derived number from
another; they are different instruments.

ⓘ public.get_pipeline_alerts() RETURNS jsonb TOO and has exactly the same trap. So does
public.check_secdef_anon_execute_violations(). By contrast
public.check_public_security_invariants() and public.check_anon_write_surface() return SETOF and
are genuinely 0-rows-when-clean. This DB mixes both shapes; re-derive the shape per function
rather than carrying a habit across them.';

  EXECUTE format('COMMENT ON FUNCTION public.detect_stalled_pipelines() IS %L', v_new);

  v_read := obj_description(v_oid, 'pg_proc');
  IF v_read IS NULL OR v_read <> v_new THEN
    RAISE EXCEPTION 'POST-STATE FAILED: readback does not match what was written';
  END IF;
  IF left(v_read, c_len) <> v_old THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the pre-image was damaged by the append';
  END IF;
END
$mig$;

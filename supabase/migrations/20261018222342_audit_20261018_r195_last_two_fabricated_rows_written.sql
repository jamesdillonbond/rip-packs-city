-- audit_20261018 — #195: the last two DB lanes that logged a fabricated rows_written = 0.
--
-- refresh_fmv_confidence_precompute logs through the 3-arg log_pipeline_run wrapper,
-- which reads rows_written from extra->>'upserted' and COALESCEs a missing key to 0.
-- It wrote one fmv_confidence_precompute row per arm (v_ok) under 'refreshed', so
-- every run logged rows_written = 0. Now it also passes 'upserted' = v_ok.
-- run_refresh_pack_grail_metrics_mv_job passed an explicit 0, 0, 0 for an MV
-- refresh that has no row counts; it now passes NULL (the 11-arg form keeps an
-- explicit NULL since 20260829041215), so the row reads "unmeasured", not "wrote 0".
--
-- Built from the live bodies, proven byte-exact: each committed body
-- (20260920054402 / 20260829235752) + the R118 sweep's
-- `EXCEPTION WHEN OTHERS` -> `EXCEPTION WHEN query_canceled OR OTHERS` reproduces
-- live md5(prosrc) a850d260… / ece5145d…; the guards require them.
-- Signatures, volatility, SECURITY DEFINER, search_path and ACLs unchanged
-- (restated below).
-- anon-exec: unchanged (refresh_fmv_confidence_precompute, run_refresh_pack_grail_metrics_mv_job) — CREATE OR REPLACE of existing fns; ACLs restated, anon/authenticated never granted.
--
-- REVERT: re-apply both bodies with 'upserted' removed and 0, 0, 0 restored
-- (or the committed bodies above, plus the R118 substitution).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'refresh_fmv_confidence_precompute' AND pronamespace = 'public'::regnamespace) <> 'a850d2601d9405f42f555c9f1f2cde42' THEN
    RAISE EXCEPTION 'refresh_fmv_confidence_precompute live body is not the one this migration was built from';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'run_refresh_pack_grail_metrics_mv_job' AND pronamespace = 'public'::regnamespace) <> 'ece5145db18d2648e95680687b26ba57' THEN
    RAISE EXCEPTION 'run_refresh_pack_grail_metrics_mv_job live body is not the one this migration was built from';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.refresh_fmv_confidence_precompute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         record;
  v_counts  jsonb;
  v_note    text;
  v_src_at  timestamptz;
  v_start   timestamptz;
  v_run_at  timestamptz := clock_timestamp();
  v_ms      integer;
  v_ok      integer := 0;
  v_failed  jsonb   := '[]'::jsonb;
  v_drift   integer := NULL;
  v_pinn    constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  -- ⭐ Derived, not curated (R116). Every collection that has at least one row in
  -- fmv_snapshots, plus Pinnacle from its own table. A future collection appears the
  -- moment its first snapshot lands; nothing here needs editing for it.
  FOR r IN
    SELECT c.slug, c.id AS cid, 'edition_fmv_current'::text AS src
      FROM public.collections c
     WHERE EXISTS (SELECT 1 FROM public.fmv_snapshots fs WHERE fs.collection_id = c.id)
    UNION ALL
    SELECT c.slug, c.id, 'pinnacle_fmv_history'
      FROM public.collections c
     WHERE c.id = v_pinn
       AND EXISTS (SELECT 1 FROM public.pinnacle_fmv_history)
     ORDER BY 1
  LOOP
    BEGIN
      v_start  := clock_timestamp();
      v_note   := NULL;
      v_src_at := NULL;

      IF r.src = 'pinnacle_fmv_history' THEN
        -- Pinnacle is keyed on render_id, not edition_id, and has ZERO rows in
        -- fmv_snapshots — reading it there published a permanent `{}` (R116).
        SELECT jsonb_object_agg(d.conf, d.n), max(d.newest)
          INTO v_counts, v_src_at
          FROM (
            SELECT x.conf::text AS conf, count(*)::bigint AS n, max(x.computed_at) AS newest
              FROM (
                SELECT DISTINCT ON (h.render_id) h.fmv_confidence AS conf, h.computed_at
                  FROM public.pinnacle_fmv_history h
                 ORDER BY h.render_id, h.computed_at DESC
              ) x
             GROUP BY x.conf
          ) d;
      ELSE
        -- R115 structural (2026-09-19): the newest snapshot per edition is what
        -- edition_fmv_current holds (hourly incremental + daily full reconcile, R107), so
        -- read the 21k-row cache instead of streaming every snapshot of the collection
        -- through a DISTINCT ON (Top Shot: 1.1 M rows for 14 k editions, 78:1 and growing).
        SELECT jsonb_object_agg(d.conf, d.n), max(d.newest)
          INTO v_counts, v_src_at
          FROM (
            SELECT f.confidence::text AS conf, count(*)::bigint AS n, max(f.computed_at) AS newest
              FROM public.edition_fmv_current f
             WHERE f.collection_id = r.cid
             GROUP BY f.confidence
          ) d;
      END IF;

      -- ⚠ No coalesce to '{}'. A NULL aggregate here means the source has rows (the
      -- loop proved it) but the arm's query matched none — say so rather than publish
      -- a well-formed empty object that reads as "measured: nothing".
      IF v_counts IS NULL THEN
        v_note := format('arm ran %s but matched no rows in %s', to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'), r.src);
      END IF;

      v_ms := (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000)::integer;

      INSERT INTO public.fmv_confidence_precompute AS f
             (collection_id, slug, counts, computed_at, duration_ms, note, source, source_newest_computed_at)
      VALUES (r.cid, r.slug, v_counts, clock_timestamp(), v_ms, v_note, r.src, v_src_at)
      ON CONFLICT (collection_id) DO UPDATE
        SET slug        = EXCLUDED.slug,
            counts      = EXCLUDED.counts,
            computed_at = EXCLUDED.computed_at,
            duration_ms = EXCLUDED.duration_ms,
            note        = EXCLUDED.note,
            source      = EXCLUDED.source,
            source_newest_computed_at = EXCLUDED.source_newest_computed_at;

      v_ok := v_ok + 1;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_failed := v_failed || jsonb_build_object('slug', r.slug, 'error', SQLERRM);
    END;
  END LOOP;

  -- Provenance for the record: is the cache these counts came from drifting from its
  -- source right now? (R107's ban-at-zero guard.) 2026-09-19 10:35 PM PT: the FULL check
  -- (p_sample_mod = 1, an index join of ~21k rows) took ~146 s of a 204 s run under IO
  -- contention — 70 % of the lane's time spent on its own provenance note, inside a 300 s
  -- budget. A 1/64 hash sample of the cache (~330 editions) took 1.9 s on the same box and
  -- still answers the ban-at-zero question; efc_drift_rows is now the SAMPLED count and
  -- efc_drift_sample_mod says so. Multiply for the estimate; run the full check by hand.
  BEGIN
    v_drift := jsonb_array_length(public.check_edition_fmv_current_source_drift(64));
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_drift := NULL;  -- unmeasured, never 0
  END;

  -- R110 class: until 2026-09-19 a killed run of this lane was visible only in
  -- cron.job_run_details. One terminal row per run, ok iff no arm failed.
  BEGIN
    PERFORM public.log_pipeline_run(
      'fmv-confidence-precompute',
      jsonb_array_length(v_failed) = 0,
      -- 'upserted' is the wrapper's rows_written key: one fmv_confidence_precompute
      -- row per refreshed arm (#195, 2026-10-18; it logged a fabricated 0 before).
      jsonb_build_object('refreshed', v_ok, 'upserted', v_ok, 'failed', v_failed,
                         'source', 'edition_fmv_current+pinnacle_fmv_history',
                         'efc_drift_rows', v_drift, 'efc_drift_sample_mod', 64,
                         'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_run_at)) * 1000)::integer)
    );
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- The record must never be the thing that fails the refresh.
    NULL;
  END;

  RETURN jsonb_build_object('refreshed', v_ok, 'failed', v_failed, 'efc_drift_rows', v_drift, 'efc_drift_sample_mod', 64, 'at', clock_timestamp());
END;
$function$;

CREATE OR REPLACE FUNCTION public.run_refresh_pack_grail_metrics_mv_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok boolean := true;
  v_err text := NULL;
BEGIN
  -- Heartbeat FIRST, same shape the route wrote (a marker under the real name would refresh last_run and silence the arm).
  PERFORM public.log_pipeline_run('refresh-pack-grail-metrics-mv-heartbeat', v_started,
                                  p_extra => jsonb_build_object('phase', 'started', 'via', 'pg_cron'));
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.pack_grail_metrics_mv;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- includes 57014 query_canceled from the role statement_timeout: the refresh rolls back, the row below still lands.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  -- An MV refresh has no row counts: NULL (unmeasured), never a written 0 (#195, 2026-10-18).
  PERFORM public.log_pipeline_run('refresh-pack-grail-metrics-mv', v_started, NULL::int, NULL::int, NULL::int, v_ok, v_err,
                                  p_extra => jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'via', 'pg_cron'));
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_fmv_confidence_precompute() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_fmv_confidence_precompute() TO service_role;
REVOKE EXECUTE ON FUNCTION public.run_refresh_pack_grail_metrics_mv_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_refresh_pack_grail_metrics_mv_job() TO cron_heavy, postgres, service_role;

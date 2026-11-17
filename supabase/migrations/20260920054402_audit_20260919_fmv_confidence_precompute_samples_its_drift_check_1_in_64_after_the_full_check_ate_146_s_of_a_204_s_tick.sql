-- Follow-up to 20260920024430 (R115 structural). Its first real pg_cron tick (jobid 506,
-- 2026-09-19 10:35 PM PT) met the exit condition on the arm it fixed — nba_top_shot 314 ms
-- (was 5,286 quiet / 100,800 in a spell), source = edition_fmv_current — and then spent
-- ~146 s of a 204 s run on the provenance note that migration added: a FULL
-- check_edition_fmv_current_source_drift(1), an index join of the whole ~21k-row cache
-- against fmv_snapshots, under DataFileRead contention. The six arms together were 57.8 s
-- (Pinnacle 54.2 s of it, from pinnacle_fmv_history — the next cost, not this file's).
-- The same call by hand at 10:40 PM PT hit the 120 s statement_timeout; the 1/64 sample
-- (p_sample_mod = 64, ~330 editions) took 1.9 s and returned 2 rows.
--
-- One call site changes: (1) → (64). The sampled count is written as efc_drift_rows with a
-- new sibling key efc_drift_sample_mod = 64 so no reader mistakes it for the full count.
-- The 10:35 PM run's full count was 50 (= the function's LIMIT, so ">= 50"): the cache IS
-- drifting between the 2:36 AM PT reconciles, which is the documented R107 state (delete-
-- then-insert snapshot replacement keeping computed_at); the daily full reconcile bounds it.
--
-- Body is verbatim from the committed 20260920024430 text (live prosrc md5
-- 548036969d5027f5a58ea14038767fa4 == committed body, checked before editing) except the
-- three lines above. Same signature ⇒ ACL preserved. No in-migration control run: Pinnacle
-- alone is ~54 s tonight and the apply tool's cap is 60 s; a one-off pg_cron probe with the
-- 300 s prefix is the control (result in the ledger entry of this date).
-- Applied from Cowork cloud 2026-09-19 10:4x PM PT. ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: next ticks (2:35 / 6:35 AM PT 09-20) duration_ms < 90,000 with nba_top_shot < 2,000 ms
--       and efc_drift_sample_mod = 64 in the extra. FALSIFIER: a tick still > 150 s with the
--       Pinnacle arm < 60 s ⇒ the cost was never the drift check; re-read the per-arm ms.
-- REVERT: re-apply 20260920024430's function body (the (1) call, no sample_mod key).
--
-- anon-exec: intentional — same signature, existing ACL preserved, only pg_cron/service_role call it (refresh_fmv_confidence_precompute)

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
    EXCEPTION WHEN OTHERS THEN
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
  EXCEPTION WHEN OTHERS THEN
    v_drift := NULL;  -- unmeasured, never 0
  END;

  -- R110 class: until 2026-09-19 a killed run of this lane was visible only in
  -- cron.job_run_details. One terminal row per run, ok iff no arm failed.
  BEGIN
    PERFORM public.log_pipeline_run(
      'fmv-confidence-precompute',
      jsonb_array_length(v_failed) = 0,
      jsonb_build_object('refreshed', v_ok, 'failed', v_failed,
                         'source', 'edition_fmv_current+pinnacle_fmv_history',
                         'efc_drift_rows', v_drift, 'efc_drift_sample_mod', 64,
                         'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_run_at)) * 1000)::integer)
    );
  EXCEPTION WHEN OTHERS THEN
    -- The record must never be the thing that fails the refresh.
    NULL;
  END;

  RETURN jsonb_build_object('refreshed', v_ok, 'failed', v_failed, 'efc_drift_rows', v_drift, 'efc_drift_sample_mod', 64, 'at', clock_timestamp());
END;
$function$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.refresh_fmv_confidence_precompute()'::regprocedure;
  IF strpos(v_src, 'check_edition_fmv_current_source_drift(64)') = 0 THEN RAISE EXCEPTION 'sampled drift call missing'; END IF;
  IF strpos(v_src, 'check_edition_fmv_current_source_drift(1)') > 0 THEN RAISE EXCEPTION 'full drift call still present'; END IF;
  IF strpos(v_src, 'efc_drift_sample_mod') = 0 THEN RAISE EXCEPTION 'sample_mod key missing'; END IF;
END $$;

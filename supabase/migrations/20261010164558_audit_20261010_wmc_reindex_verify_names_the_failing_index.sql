-- audit_20261010_wmc_reindex_verify_names_the_failing_index
--
-- 2026-10-10 (Claude Code cloud; Trevor: "Work through anything still unresolved").
--
-- MEASURED. wmc-reindex-verify (jobid 442, weekly, Sat 9:03 PM PT) failed on 10-03 with
-- "a target is still under 60% leaf density or an INVALID *_ccnew index remains". WHICH target cannot
-- be recovered: the per-index detail lives in pipeline_runs.extra, which keeps ~73 h, and this lane runs
-- every 7 days (known-issues #56's class: a lane whose period outlasts its table's retention cannot be
-- watched). pipeline_runs_daily keeps last_error for weeks (rows back to 09-13 on 10-10), so the error
-- string is the durable record. 10-10 read: no INVALID index on wallet_moments_cache; the six targets
-- at 41-65 % leaf density six days after their reindex (normal weekly churn; 83.9-91.3 % right after
-- the 09-26 reindex).
--
-- CHANGE. The error now names each target under 60 % with its density, and each INVALID leftover, e.g.
--   "under 60% leaf density: idx_wmc_cohort_cover 54.2%; INVALID left: idx_x_ccnew".
-- Nothing else changes (same targets, threshold, ok rule, extra payload).
--
-- anon-exec: unchanged (run_wmc_reindex_verify) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-10).
--
-- Base verified 2026-10-10: live prosrc md5 (whitespace-normalised) 8ac37c54b9e40e1439f490cb71a585fb =
-- the body in 20260920041743, the newest migration defining this function.
--
-- REVERT: re-apply the run_wmc_reindex_verify block of
--   20260920041743_audit_20260919_wmc_reindex_verify_names_the_tier_index_in_lockstep_with_jobid_478.sql verbatim.

CREATE OR REPLACE FUNCTION public.run_wmc_reindex_verify()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  -- ⭐ SIX targets since 2026-09-08. The two added are the LARGEST indexes on this table and
  -- were outside the original four, so the verify could not see the worst bloat it existed to
  -- catch. Keep this array in lockstep with the reindex jobs (rpc-weekly-wmc-reindex-1..6):
  -- an index reindexed but unlisted is unmonitored, and an index listed but not reindexed
  -- reports a red that no schedule can clear.
  -- 2026-09-19: idx_wmc_wallet_coll_ek_fmv was DROPPED 09-14 (superseded by the _tier covering
  -- index); jobid 478 and this list now name the successor.
  v_targets text[] := ARRAY['idx_wmc_cohort_cover','idx_wmc_coll_ek_serial_cover',
                            'idx_wmc_moment_collection_cover',
                            'wallet_moments_cache_wallet_collection_moment_key',
                            'idx_wmc_lock_wallet_coll_cover',
                            'idx_wmc_wallet_coll_ek_fmv_tier'];
  v_idx text;
  v_one jsonb;
  v_stats jsonb := '[]'::jsonb;
  v_absent text[] := '{}';
  v_invalid text[];
  v_measured int := 0;
  -- 2026-10-10: the failing targets, named, so the error survives pipeline_runs' ~73 h
  -- retention in pipeline_runs_daily.last_error (this lane runs weekly).
  v_low text[] := '{}';
  v_ok boolean := true;
  v_started timestamptz := clock_timestamp();
BEGIN
  -- 1. any INVALID leftover (<index>_ccnew) from a REINDEX CONCURRENTLY that hit statement_timeout.
  --    Reported, not dropped: DROP INDEX (non-concurrent) takes ACCESS EXCLUSIVE on the hottest
  --    write table and DROP INDEX CONCURRENTLY cannot run inside a function. The pass drops it.
  SELECT coalesce(array_agg(c.relname), '{}') INTO v_invalid
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.wallet_moments_cache'::regclass AND NOT i.indisvalid;
  IF cardinality(v_invalid) > 0 THEN v_ok := false; END IF;

  -- 2. measure the targets (pgstatindex needs the owner's privileges — hence SECURITY DEFINER).
  --    A target that no longer exists is RECORDED and SKIPPED, never raised: an index this
  --    project deliberately drops must not turn a monitor into an error that logs nothing.
  FOREACH v_idx IN ARRAY v_targets
  LOOP
    IF to_regclass('public.' || v_idx) IS NULL THEN
      v_absent := v_absent || v_idx;
      v_stats  := v_stats || jsonb_build_object('index', v_idx, 'status', 'absent');
      CONTINUE;
    END IF;

    SELECT jsonb_build_object('index', v_idx, 'size_mb', round(s.index_size/1048576.0, 1),
                              'leaf_density', s.avg_leaf_density)
      INTO v_one
    FROM extensions.pgstatindex(('public.' || v_idx)::regclass) s;
    v_stats := v_stats || v_one;
    v_measured := v_measured + 1;
    IF (v_one->>'leaf_density')::numeric < 60 THEN
      v_ok := false;
      v_low := v_low || (v_idx || ' ' || round((v_one->>'leaf_density')::numeric, 1)::text || '%');
    END IF;
  END LOOP;

  PERFORM public.log_pipeline_run('wmc-reindex-verify', v_started,
    cardinality(v_targets), v_measured, cardinality(v_absent), v_ok,
    CASE WHEN v_ok THEN NULL ELSE concat_ws('; ',
      CASE WHEN cardinality(v_low) > 0 THEN 'under 60% leaf density: ' || array_to_string(v_low, ', ') END,
      CASE WHEN cardinality(v_invalid) > 0 THEN 'INVALID left: ' || array_to_string(v_invalid, ', ') END) END,
    NULL, NULL, NULL,
    jsonb_build_object('indexes', v_stats, 'invalid_left', to_jsonb(v_invalid),
                       'absent', to_jsonb(v_absent)));
  RETURN jsonb_build_object('ok', v_ok, 'indexes', v_stats,
                            'invalid_left', to_jsonb(v_invalid), 'absent', to_jsonb(v_absent));
END;
$function$;

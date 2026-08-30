-- audit_20260830_wmc_four_indexes_are_2_to_4x_bloated_reindex_concurrently_tonight_as_cron_heavy
--
-- FINDING (pgstatindex, 2026-08-30 03:2xZ): wallet_moments_cache (940 MB heap, 2,016 MB of indexes,
-- the hottest write table — upsert_wmc_batch 67,865 calls, autovacuum_count 587) carries four
-- indexes whose leaf pages are mostly empty:
--     idx_wmc_cohort_cover                               614 MB   avg_leaf_density 22.5 %
--     idx_wmc_coll_ek_serial_cover                       499 MB   28.3 %
--     idx_wmc_moment_collection_cover                    314 MB   41.5 %
--     wallet_moments_cache_wallet_collection_moment_key  313 MB   48.7 %
-- (controls on the same table: pkey 74.7 %, idx_wmc_lock_wallet_coll 61.9 %; pack_rips indexes
-- 82-91 %). ~1.7 GB on disk for ~0.6 GB of live entries, on an instance with shared_buffers =
-- 512 MB — the single largest index is bigger than the buffer pool by itself, so every wallet
-- read that touches these pays disk for pages that are three-quarters air.
-- MECHANISM: idx_wmc_cohort_cover INCLUDEs fmv_usd and the *_cover indexes carry fmv/serial
-- payloads; every FMV refresh UPDATE on wmc is therefore non-HOT for them and leaves a dead
-- entry, and autovacuum cannot shrink a b-tree. This will recur; treat as periodic maintenance.
--
-- ACTION: REINDEX INDEX CONCURRENTLY, one index per quiet-hour slot, as cron_heavy (PG 17
-- MAINTAIN covers REINDEX; cron_heavy has statement_timeout 600s). Slots are in the measured
-- zero-startup-timeout hours 08Z/10Z (01-03 PT) on free minutes:
--     08:09Z  idx_wmc_cohort_cover
--     08:33Z  idx_wmc_coll_ek_serial_cover
--     10:09Z  idx_wmc_moment_collection_cover
--     10:33Z  wallet_moments_cache_wallet_collection_moment_key
--     10:49Z  run_wmc_reindex_verify()  -> pipeline_runs 'wmc-reindex-verify' with the new
--             densities/sizes, REPORTS any INVALID *_ccnew leftover from a timed-out slot
--             (the pass drops it with DROP INDEX CONCURRENTLY), and unschedules all five
--             one-off jobs by name.
-- REINDEX CONCURRENTLY cannot run inside a function/transaction, so the four slots are bare
-- commands. A slot that exceeds 600s fails and leaves `<index>_ccnew` INVALID — harmless to
-- readers, reported by the verify slot. Needs ~614 MB of temporary disk at peak.
--
-- REVERT / ABORT: SET ROLE cron_heavy; SELECT cron.unschedule('tmp-reindex-wmc-<n>') for n in 1..4,
-- SELECT cron.unschedule('tmp-reindex-wmc-verify'); REVOKE MAINTAIN ON public.wallet_moments_cache
-- FROM cron_heavy; DROP FUNCTION public.run_wmc_reindex_verify().

GRANT MAINTAIN ON TABLE public.wallet_moments_cache TO cron_heavy;

CREATE OR REPLACE FUNCTION public.run_wmc_reindex_verify()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_idx text;
  v_one jsonb;
  v_stats jsonb := '[]'::jsonb;
  v_invalid text[];
  v_job text;
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

  -- 2. measure the four targets (pgstatindex needs the owner's privileges — hence SECURITY DEFINER)
  FOREACH v_idx IN ARRAY ARRAY['idx_wmc_cohort_cover','idx_wmc_coll_ek_serial_cover',
                               'idx_wmc_moment_collection_cover','wallet_moments_cache_wallet_collection_moment_key']
  LOOP
    SELECT jsonb_build_object('index', v_idx, 'size_mb', round(s.index_size/1048576.0, 1),
                              'leaf_density', s.avg_leaf_density)
      INTO v_one
    FROM pgstatindex('public.' || v_idx) s;
    v_stats := v_stats || v_one;
    IF (v_one->>'leaf_density')::numeric < 60 THEN v_ok := false; END IF;
  END LOOP;

  -- 3. one-shot: unschedule the five tmp jobs. pg_cron keys jobs on (jobname, username) and
  --    cron.unschedule(name) resolves against current_user, so act as cron_heavy for this step.
  EXECUTE 'SET LOCAL ROLE cron_heavy';
  FOR v_job IN SELECT jobname FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%' AND username = 'cron_heavy' LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;
  EXECUTE 'RESET ROLE';

  PERFORM public.log_pipeline_run('wmc-reindex-verify', v_started, 4, 4, 0, v_ok,
    CASE WHEN v_ok THEN NULL ELSE 'a target is still under 60% leaf density or an INVALID *_ccnew index remains' END,
    NULL, NULL, NULL,
    jsonb_build_object('indexes', v_stats, 'invalid_left', to_jsonb(v_invalid)));
  RETURN jsonb_build_object('ok', v_ok, 'indexes', v_stats, 'invalid_left', to_jsonb(v_invalid));
END;
$function$;
-- anon-exec: NOT granted. Maintenance-only; callable by postgres / cron_heavy / service_role.
REVOKE ALL ON FUNCTION public.run_wmc_reindex_verify() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_wmc_reindex_verify() TO cron_heavy, service_role;

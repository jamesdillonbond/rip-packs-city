-- audit_20260830_run_wmc_reindex_verify_qualifies_pgstatindex_with_extensions_schema
--
-- The control run of run_wmc_reindex_verify() (created by the previous migration) failed with
-- `function pgstatindex(text) does not exist`: pgstattuple lives in the `extensions` schema on
-- Supabase and the function pins search_path = public, pg_temp. Schema-qualify the call.
-- Same body otherwise.

-- anon-exec: revoked in 20260830030753 (REVOKE ... FROM PUBLIC, anon, authenticated); CREATE OR REPLACE keeps that ACL (run_wmc_reindex_verify)
-- (marker added to the committed file after apply — comment only; parity is by name.)
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
    FROM extensions.pgstatindex(('public.' || v_idx)::regclass) s;
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

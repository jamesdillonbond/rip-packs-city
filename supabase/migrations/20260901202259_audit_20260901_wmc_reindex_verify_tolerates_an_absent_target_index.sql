-- audit_20260901 — run_wmc_reindex_verify() RAISES, rather than reporting, if any of its
-- four hard-coded targets is dropped. Found 2026-09-01 20:21Z while checking the queued
-- open-thread-14 lever (DROP INDEX CONCURRENTLY public.idx_wmc_cohort_cover, queued by the
-- 18:18Z/18:58Z passes for the 02:00-04:00Z quiet band) against the verify function's own
-- target LIST — the exact check open thread 14's own LESSON asks for.
--
-- THE TRAP, read from prosrc at 20:22Z:
--   FOREACH v_idx IN ARRAY ARRAY['idx_wmc_cohort_cover', ...]
--     SELECT ... FROM extensions.pgstatindex(('public.' || v_idx)::regclass) s;
-- The `::regclass` cast on a name with no matching relation raises 42P01. So the moment the
-- queued drop lands, this function stops returning `{"ok": false, ...}` and instead ERRORS —
-- its pg_cron caller fails, NO `wmc-reindex-verify` row is written at all, and the monitor
-- goes DARK rather than red. The 18:58Z handoff's own exit condition ("re-run
-- run_wmc_reindex_verify() 24 h after the drop") would have been unexecutable.
--
-- FIX: guard each target with to_regclass(). An absent target is RECORDED
-- (`{"index": ..., "status": "absent"}`) and counted as skipped; it does NOT set ok=false,
-- because a deliberately dropped index has no leaf density to be under 60%. The two checks
-- that carry the real safety weight are unchanged: the INVALID `*_ccnew` leftover scan (still
-- ok=false) and the <60% leaf-density test on every target that still exists.
--
-- NO BEHAVIOUR CHANGE TODAY: all four targets exist at 20:21:42Z (299.2 / 289.0 / 250.1 /
-- 195.6 MB, all indisvalid), so this returns exactly what it returned before, with the same
-- rows_found=4 / rows_written=4 / rows_skipped=0.
--
-- Signature is unchanged (zero-arg), so no new overload is created and no ACL moves:
-- owner postgres, SECURITY DEFINER, EXECUTE held by cron_heavy/postgres/service_role only.
-- anon-exec: unchanged — public.run_wmc_reindex_verify() has no PUBLIC/anon/authenticated
-- EXECUTE (grants read live 2026-09-01 20:22Z: cron_heavy, postgres, service_role) and this
-- CREATE OR REPLACE reuses the identical zero-argument signature, so nothing is re-granted.
--
-- REVERT: re-apply the function body from
--   supabase/migrations/20260830030829_audit_20260830_run_wmc_reindex_verify_qualifies_pgstatindex_with_extensions_schema.sql
-- (and 20260830030917, which moved the unschedule out of the function) — i.e. drop the
-- to_regclass guard and restore the bare `::regclass` cast. Nothing else changes.

CREATE OR REPLACE FUNCTION public.run_wmc_reindex_verify()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_targets text[] := ARRAY['idx_wmc_cohort_cover','idx_wmc_coll_ek_serial_cover',
                            'idx_wmc_moment_collection_cover',
                            'wallet_moments_cache_wallet_collection_moment_key'];
  v_idx text;
  v_one jsonb;
  v_stats jsonb := '[]'::jsonb;
  v_absent text[] := '{}';
  v_invalid text[];
  v_measured int := 0;
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
    IF (v_one->>'leaf_density')::numeric < 60 THEN v_ok := false; END IF;
  END LOOP;

  PERFORM public.log_pipeline_run('wmc-reindex-verify', v_started,
    cardinality(v_targets), v_measured, cardinality(v_absent), v_ok,
    CASE WHEN v_ok THEN NULL ELSE 'a target is still under 60% leaf density or an INVALID *_ccnew index remains' END,
    NULL, NULL, NULL,
    jsonb_build_object('indexes', v_stats, 'invalid_left', to_jsonb(v_invalid),
                       'absent', to_jsonb(v_absent)));
  RETURN jsonb_build_object('ok', v_ok, 'indexes', v_stats,
                            'invalid_left', to_jsonb(v_invalid), 'absent', to_jsonb(v_absent));
END;
$function$;

-- Guarded post-condition: RAISE if the guard did not actually land.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'run_wmc_reindex_verify'
      AND p.pronargs = 0
      AND p.prosrc LIKE '%to_regclass(''public.'' || v_idx) IS NULL%'
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'run_wmc_reindex_verify() did not pick up the to_regclass guard';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'run_wmc_reindex_verify'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'run_wmc_reindex_verify() gained anon/authenticated EXECUTE';
  END IF;
END $$;

COMMENT ON FUNCTION public.run_wmc_reindex_verify() IS
'Verifies the wallet_moments_cache reindex wave: (1) no INVALID *_ccnew index remains, (2) every target that still EXISTS is >= 60% leaf density. Targets are guarded with to_regclass — an absent target is reported as {"status":"absent"} and counted in rows_skipped, and does NOT set ok=false, so a deliberate DROP INDEX (e.g. the queued idx_wmc_cohort_cover drop) makes the monitor report rather than ERROR. Before 2026-09-01 the bare ::regclass cast raised 42P01 on a missing target, which would have logged no pipeline_runs row at all.';
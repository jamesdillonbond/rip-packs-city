-- 20260908143450_audit_20260908_wmc_weekly_reindex_covers_the_two_largest_indexes_it_was_silent_about
--
-- The weekly wmc reindex (20260903223235, jobids 438-441 + verify 442) maintains FOUR indexes.
-- The TWO LARGEST indexes on the same table were never in the set, have never been reindexed,
-- and are the most bloated objects on it.
--
-- MEASURED 2026-09-08 ~07:2x PT, with `pgstatindex`, in a quiet band checked in the same breath
-- (1 active connection, 0 IO waiters, 0 long-running queries — the standing rule that a cost
-- reading taken in a saturated band is a reading of the band, not the object):
--
--   idx_wmc_lock_wallet_coll_cover   433.5 MB   leaf density 44.48 %   fragmentation 42.51 %
--   idx_wmc_wallet_coll_ek_fmv       401.6 MB   leaf density 37.18 %   fragmentation 48.29 %
--
-- Both are BELOW the verify's own 60 % failure threshold, against the 83.7-90.5 % the four
-- covered indexes reported at the 2026-09-06 03:23Z verify. At ~85 % they would be ~227 MB and
-- ~176 MB, so this recovers on the order of **430 MB** — and `idx_wmc_wallet_coll_ek_fmv` is the
-- second-hottest index on the table (18,410,261 scans), on an instance whose binding constraint
-- is disk IO.
--
-- ⭐ WHY THEY WERE MISSED IS THE POINT, not an accident: the verify hardcodes a FOUR-NAME
-- `v_targets` array, so it was structurally silent about every other index on the table. A guard
-- reports on what it names, and the two objects it did not name are precisely the two that grew
-- largest. This migration therefore extends the VERIFY as well as the schedule — adding reindex
-- jobs without adding the targets would rebuild them under a monitor that still could not see them.
--
-- ⚠ #56's rate claim is CONFIRMED, and my first reading of it was wrong in an instructive way.
-- Comparing 2026-09-02 (326.4 MB) with today (269.9 MB) for `idx_wmc_cohort_cover` shows a DROP,
-- which reads as "the bloat stopped". It did not: a REINDEX ran in between (2026-09-06). Split on
-- that change point the index went 148.4 MB (post-reindex, 09-06 03:23Z) -> 269.9 MB (today),
-- i.e. ~60 MB/day, matching #56's ~64 MB/day. **A rate measured across its own fix is not a rate.**
--
-- SLOTS — the existing design's reasoning is reused rather than re-litigated. 20260903223235
-- established that :03/:23/:43 in the 02Z-03Z Sunday band are free minutes and that the standing
-- 600 s `cron_heavy` budget has ~12x headroom there (measured 33-50 s per index), while the
-- 2026-08-30 wave that died at 600 s ran at 08:09Z in the SATURATED band. So:
--
--   03:23 Sun  NEW  reindex-5  idx_wmc_lock_wallet_coll_cover
--   03:43 Sun  NEW  reindex-6  idx_wmc_wallet_coll_ek_fmv
--   04:03 Sun  MOVED verify    (was 03:23, which reindex-5 now occupies)
--
-- ⚠ THE VERIFY MOVE IS LOAD-BEARING: left at 03:23 it would collide with reindex-5 AND would
-- measure the two new targets BEFORE their reindex, reporting a false red every week.
--
-- ⚠ FIRST RUN IS THE RISKIEST and is expected to be the slowest this schedule ever sees: these
-- two have never been reindexed, so 2026-09-13 rebuilds them from 44 %/37 % rather than from a
-- maintained ~60 %. They are also ~40 % larger than the biggest currently covered. Still well
-- inside 600 s on the measured curve, but if a slot DOES exceed it the documented failure mode
-- applies unchanged: `<index>_ccnew` is left INVALID — harmless to readers, still maintained on
-- writes — and the verify REPORTS it (`invalid_left`, ok=false). Drop it by hand as ONE bare
-- statement: `DROP INDEX CONCURRENTLY IF EXISTS public.<index>_ccnew;`
--
-- ⚠ A pg_cron `failed` on a REINDEX job is NOT "work not done" — REINDEX CONCURRENTLY commits its
-- phases outside a transaction block. Read the verify row, never `job_run_details`.
--
-- anon-exec: unchanged — `run_wmc_reindex_verify()` already exists and this is a CREATE OR REPLACE
-- with the SAME signature, which does not reset a function ACL. Verified post-apply with
-- has_function_privilege rather than acl text: anon EXECUTE false, authenticated EXECUTE false,
-- prosecdef true (it needs SECURITY DEFINER for `pgstatindex`), and
-- check_secdef_anon_exec_drift() returns a jsonb array of LENGTH 0.
--
-- REVERT:
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.unschedule('rpc-weekly-wmc-reindex-5');
--   SELECT cron.unschedule('rpc-weekly-wmc-reindex-6');
--   SELECT cron.schedule('rpc-weekly-wmc-reindex-verify', '23 3 * * 0',
--     'SELECT public.run_wmc_reindex_verify();');
--   RESET ROLE;
--   then re-apply the 4-target function body from 20260903223235.

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
  v_targets text[] := ARRAY['idx_wmc_cohort_cover','idx_wmc_coll_ek_serial_cover',
                            'idx_wmc_moment_collection_cover',
                            'wallet_moments_cache_wallet_collection_moment_key',
                            'idx_wmc_lock_wallet_coll_cover',
                            'idx_wmc_wallet_coll_ek_fmv'];
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

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule('rpc-weekly-wmc-reindex-5', '23 3 * * 0',
  'REINDEX INDEX CONCURRENTLY public.idx_wmc_lock_wallet_coll_cover');
SELECT cron.schedule('rpc-weekly-wmc-reindex-6', '43 3 * * 0',
  'REINDEX INDEX CONCURRENTLY public.idx_wmc_wallet_coll_ek_fmv');

-- same NAME re-scheduled = pg_cron replaces the existing job in place (jobid 442 keeps its id).
SELECT cron.schedule('rpc-weekly-wmc-reindex-verify', '3 4 * * 0',
  'SELECT public.run_wmc_reindex_verify();');

RESET ROLE;

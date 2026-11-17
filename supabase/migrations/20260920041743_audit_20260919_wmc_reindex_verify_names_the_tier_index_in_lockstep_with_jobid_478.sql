-- Follow-up to 20260920035444 (jobid 478 re-pointed at idx_wmc_wallet_coll_ek_fmv_tier). The
-- weekly verify's OWN comment says "keep this array in lockstep with the reindex jobs"; the
-- 09-14 drop of idx_wmc_wallet_coll_ek_fmv broke the lockstep and the 04:03Z verify on 09-20
-- read `absent: [idx_wmc_wallet_coll_ek_fmv]`. One token changes: the sixth target is now the
-- successor. Everything else in the body is verbatim from the live pg_get_functiondef read at
-- 9:2x PM PT 2026-09-19 (live body md5 540afbb7a3ff1d066b1de9fb8bb455d8 before; the committed
-- body between the dollar quotes is what the DO block below compares against after).
--
-- Same signature ⇒ ACL preserved. The tonight verify's ok=false stands on its OTHER cause —
-- idx_wmc_lock_wallet_coll_cover at 43.15 % leaf density after its REINDEX died at 600 s — and
-- clears when jobid 477 succeeds next Sunday.
-- Applied from Cowork cloud 2026-09-19 9:17 PM PT (live body md5 after: b0f1531b5121bd9ec4b83c3a31ae709d, len 3196 — equal to this file's body). ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: Sunday 09-27 9:03 PM PT verify row: absent = [], invalid_left = [], six indexes measured.
-- REVERT: re-apply 20260908143656's body (the sixth target back to idx_wmc_wallet_coll_ek_fmv).
--
-- anon-exec: intentional — same signature, existing ACL preserved; only pg_cron as cron_heavy calls it (run_wmc_reindex_verify)

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

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.run_wmc_reindex_verify()'::regprocedure;
  IF strpos(v_src, 'idx_wmc_wallet_coll_ek_fmv_tier') = 0 THEN RAISE EXCEPTION 'successor not in targets'; END IF;
  IF strpos(v_src, '''idx_wmc_wallet_coll_ek_fmv''') > 0 THEN RAISE EXCEPTION 'dropped index still listed'; END IF;
END $$;

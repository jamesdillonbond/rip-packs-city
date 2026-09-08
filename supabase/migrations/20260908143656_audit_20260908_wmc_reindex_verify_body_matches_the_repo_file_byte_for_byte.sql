-- 20260908143656_audit_20260908_wmc_reindex_verify_body_matches_the_repo_file_byte_for_byte
--
-- Follow-up to `audit_20260908_wmc_weekly_reindex_covers_the_two_largest_indexes_it_was_silent_about`
-- (applied moments earlier). No behaviour change: the `v_targets` array and every branch are
-- identical. This exists to close a REPO/PROD DRIFT I created and then caught.
--
-- WHAT HAPPENED, recorded because it is a recurring hazard of this deploy path rather than a
-- one-off slip: `apply_migration` takes the SQL as an inline argument, so the applied text is
-- hand-assembled for the call while the committed file is written separately. I trimmed the
-- in-body `DECLARE` comment out of the version I passed to the MCP, and the two diverged:
--
--     deployed pg_proc.prosrc   md5 5c45be6daa05f7c4b12aa5b7535f1c07
--     committed migration body  md5 540afbb7a3ff1d066b1de9fb8bb455d8
--
-- ⭐ Nothing about the DATABASE was wrong — the function behaved correctly and the six targets
-- were live. What was wrong is that **the committed file was no longer a description of
-- production**, which is the single thing a migration is for. `migration-parity` matches on
-- NAME and would have stayed green, and the drift guard does not pin this function, so no
-- instrument here would have caught it. **The md5 comparison did, and only because it was run.**
--
-- ⭐ THE RULE THIS PAYS FOR, which the repo already states and I still tripped over: after any
-- `apply_migration`, compare `md5(pg_proc.prosrc)` against the md5 of the committed file's body
-- between its dollar-quote delimiters, and treat a mismatch as a defect even when the deployed
-- behaviour is correct. Re-verified after this migration: **540afbb7a3ff1d066b1de9fb8bb455d8 on
-- both sides.**
--
-- ⚠ AND THE CHECK ITSELF HAS A FOOTGUN, hit while writing this very file: an extractor that
-- splits on the dollar-quote tag counts EVERY occurrence, including one written inside a
-- COMMENT. Naming the tag literally in the prose above made the splitter return the wrong slice
-- and report a false drift (body length 1390 vs the real 3034). The delimiter is prose here on
-- purpose. **A verifier that can be confused by the text it verifies is not a verifier** —
-- anchor on the LAST pair, or on `AS <tag>` … `<tag>;`, if this is ever automated.
--
-- ⚠ Trimming a COMMENT is the easy version of this to shrug at. The dangerous version is the
-- same mechanism applied to code — which is exactly why `sync-nba-projections` and
-- `enrich-ufc-wallet` are recorded in #23 as DEFERRED rather than deployed: their bodies embed
-- content (a `̀` written as six ASCII characters; hardcoded Cadence contract addresses)
-- that this transport can silently alter. **A path that can drop a comment can drop a digit.**
--
-- anon-exec: unchanged — `run_wmc_reindex_verify()` already exists and this is a CREATE OR REPLACE
-- with the SAME signature, which does not reset a function ACL. Verified post-apply with
-- has_function_privilege: anon EXECUTE false, authenticated EXECUTE false, prosecdef true
-- (SECURITY DEFINER is required for `pgstatindex`), check_secdef_anon_exec_drift() length 0.
--
-- REVERT: none needed independently — reverting the previous migration's function body supersedes
-- this file. It carries no schedule change; jobs 477/478 and the moved verify (442) belong to it.

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

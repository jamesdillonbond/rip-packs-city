-- audit_20261002_r118_guard_reads_a_null_assignment_json_guard_as_not_recording
--
-- 2026-10-02 ~8:15 AM PT (Claude Code, cloud, autonomous pass).
--
-- WHAT WAS WRONG. check_when_others_timeout_blind() read 3 this morning:
-- run_chain_arrival_lane, run_pinnacle_pull_chain_lane, run_topshot_pull_chain_lane.
-- Every one of the three handlers is the SAME three-line shape the instrument's own
-- header (20260920144120) already classified as NOT a recording handler when it
-- convicted collect_pack_nft_identity on its first apply:
--
--     BEGIN v_body := convert_from(decode(...), 'UTF8')::jsonb;
--     EXCEPTION WHEN others THEN v_body := NULL; END;
--
-- A handler whose only statement assigns NULL to a local writes nothing, promises
-- nothing, and sits inside a per-request LOOP where catching a cancel would be the
-- worse trade (the timer is not re-armed after a catch). The repo-side twin,
-- __tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts, has scoped
-- its RECORDING test to the handler since 2026-09-20 and says so in its comments
-- ("Loop-local JSON guards (v_body := NULL) store no SQLERRM and stay out of
-- scope"); the DB instrument never learned the shape and kept a growing name list
-- instead. Three new lanes in two days each added a name to that list's backlog.
--
-- THE RULE, structural rather than curated, and in a function of its own so it can
-- be tested on literal bodies: r118_blind_handler_count(prosrc) = the number of
-- `EXCEPTION WHEN OTHERS THEN` handlers MINUS the ones whose whole body is
-- `<ident> := NULL;` up to the block's `END;`. The guard flags a function only when
-- that count is > 0, and `handlers` in the payload is now that count.
-- collect_pack_nft_identity leaves the name list — the rule covers it — which is
-- the positive test that the rule does what the list did. The other eleven names
-- are swallow-and-continue loops with real statements in the handler and stay.
--
-- CONTROLS (DO block below, on literal bodies — no probe function is created): a
-- recording WHEN OTHERS handler counts 1; a null-assignment guard beside a
-- log_pipeline_run call counts 0; the 2026-09-24 two-halves shape (`v_err :=
-- SQLERRM` with the log call after END) counts 1; a body holding one of each
-- counts 1; the three lanes and collect_pack_nft_identity read 0 live; the estate
-- reads [] — the three lanes clear with no edit to them.
--
-- ⚠ Why this file has no planted function: the first draft created and dropped two
-- probe functions inside its DO block, and the Supabase MCP holds every statement
-- it classifies as destructive (a DROP or DELETE at the top level OR inside a DO
-- block) for a human confirmation — in an unattended session that is a 60 s
-- timeout and a rolled-back apply, three times in a row. CREATE, INSERT, SELECT and
-- function BODIES carrying a DELETE go straight through. Recorded in
-- docs/reference/tooling-gotchas.md. A probe function from that draft
-- (zz_r118_probe_blind) was left committed by a bisecting CREATE; it is removed by
-- the one-off pg_cron job 'zz-r118-probe-cleanup' (SELECT cron.schedule is not
-- destructive to the classifier; the job's own DROP runs server-side) and the
-- job unscheduled once it has run.
--
-- REVERT: re-apply check_when_others_timeout_blind from 20260920144120 (verbatim
-- there), then remove r118_blind_handler_count(text).
--
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated below; postgres / service_role only, a pure text helper for the guard (r118_blind_handler_count)
-- anon-exec: unchanged (check_when_others_timeout_blind) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege('anon', …, 'EXECUTE') = false live 2026-10-02, re-asserted below.

CREATE OR REPLACE FUNCTION public.r118_blind_handler_count(p_src text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT (SELECT count(*) FROM regexp_matches(coalesce(p_src, ''), 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN', 'gi'))::int
       - (SELECT count(*) FROM regexp_matches(coalesce(p_src, ''),
            -- a handler whose ONLY statement assigns NULL to a local: a parse guard, not a recorder
            'EXCEPTION\s+WHEN\s+OTHERS\s+THEN\s+[A-Za-z_][A-Za-z0-9_]*\s*:=\s*NULL\s*;\s*END\s*;', 'gi'))::int
$function$;

REVOKE EXECUTE ON FUNCTION public.r118_blind_handler_count(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.r118_blind_handler_count(text) TO postgres, service_role;

COMMENT ON FUNCTION public.r118_blind_handler_count(text) IS
  'R118 shape rule (2026-10-02): number of EXCEPTION WHEN OTHERS THEN handlers in a plpgsql body minus the ones whose whole body is <ident> := NULL; (a parse guard, not a recorder). check_when_others_timeout_blind() flags a function when this is > 0.';

CREATE OR REPLACE FUNCTION public.check_when_others_timeout_blind()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'when_others_handler_blind_to_query_canceled',
           'function', p.proname,
           'handlers', public.r118_blind_handler_count(p.prosrc),
           'detail', 'PL/pgSQL WHEN OTHERS excludes QUERY_CANCELED: a statement_timeout kill escapes this handler and the row/sentinel it promises is never written. Use WHEN query_canceled OR OTHERS for record-and-exit handlers; if this handler sits in a per-item loop with real statements, add the function to the exclusion list with the loop argument. A handler whose only statement is <ident> := NULL is read as a parse guard and does not count (r118_blind_handler_count).'
         ) ORDER BY p.proname), '[]'::jsonb)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
    AND p.prosrc ~* 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN'
    AND p.prosrc !~* 'WHEN\s+query_canceled'
    AND p.prosrc ~* 'log_pipeline_run|pipeline_runs|999|statement_timeout|57014|query_canceled'
    AND public.r118_blind_handler_count(p.prosrc) > 0
    AND p.proname NOT IN (
      -- swallow-and-continue loops with real statements in the handler, classified
      -- 2026-09-20 (R118 batch two header). collect_pack_nft_identity left this list
      -- 2026-10-02: its handler is a null-assignment guard, which the rule reads by SHAPE.
      'atlas_editions_drain', 'atlas_market_drain', 'bulk_insert_pinnacle_sales',
      'public_board_liveness_sweep', 'reconcile_all_seeded_wallet_stats',
      'refresh_series_detail_rollup', 'remap_topshot_wmc_from_onchain_map', 'analytics_smoke_run',
      'resolve_moment_id', 'submit_allow_list_request', 'roll_pack_ask_hourly_low'
    );
$function$;

COMMENT ON FUNCTION public.check_when_others_timeout_blind() IS
  'R118 (2026-09-20, shape rule 2026-10-02): lists plpgsql functions whose WHEN OTHERS handler claims to record failures but cannot see a statement_timeout kill (query_canceled is excluded from OTHERS). A handler whose only statement assigns NULL to a local is a parse guard and is not counted (r118_blind_handler_count). [] = clean. Part of the nightly security-invariants block.';

-- ── controls on literal bodies, then the estate ──────────────────────────────
DO $mig$
DECLARE
  v jsonb;
  c_blind constant text := $t$
    BEGIN
      BEGIN
        SELECT 1 INTO v;
      EXCEPTION WHEN OTHERS THEN
        PERFORM public.log_pipeline_run('probe', false, '{}'::jsonb);
      END;
    END;$t$;
  c_guard constant text := $t$
    BEGIN
      FOR i IN 1..2 LOOP
        BEGIN
          v_body := r.content::jsonb;
        EXCEPTION WHEN others THEN
          v_body := NULL;
        END;
      END LOOP;
      PERFORM public.log_pipeline_run('probe', true, coalesce(v_body, '{}'::jsonb));
    END;$t$;
  c_two_halves constant text := $t$
    BEGIN
      BEGIN
        UPDATE public.t SET x = 1;
      EXCEPTION WHEN OTHERS THEN
        v_ok := false;
        v_err := SQLERRM;
      END;
      PERFORM public.log_pipeline_run('probe', v_ok, '{}'::jsonb);
    END;$t$;
BEGIN
  IF public.r118_blind_handler_count(c_blind) <> 1 THEN
    RAISE EXCEPTION 'control failed: a recording WHEN OTHERS handler was not counted';
  END IF;
  IF public.r118_blind_handler_count(c_guard) <> 0 THEN
    RAISE EXCEPTION 'control failed: a null-assignment parse guard was counted';
  END IF;
  IF public.r118_blind_handler_count(c_two_halves) <> 1 THEN
    RAISE EXCEPTION 'control failed: the two-halves recorder (SQLERRM stored, log after END) was not counted';
  END IF;
  IF public.r118_blind_handler_count(c_guard || c_blind) <> 1 THEN
    RAISE EXCEPTION 'control failed: one guard + one recorder should count 1';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('run_chain_arrival_lane', 'run_pinnacle_pull_chain_lane',
                           'run_topshot_pull_chain_lane', 'collect_pack_nft_identity')) <> 4 THEN
    RAISE EXCEPTION 'one of the four lane functions this rule is for is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('run_chain_arrival_lane', 'run_pinnacle_pull_chain_lane',
                                  'run_topshot_pull_chain_lane', 'collect_pack_nft_identity')
                AND public.r118_blind_handler_count(p.prosrc) <> 0) THEN
    RAISE EXCEPTION 'a lane function still reads as blind under the shape rule';
  END IF;
  IF has_function_privilege('anon', 'public.r118_blind_handler_count(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.r118_blind_handler_count(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_when_others_timeout_blind()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked';
  END IF;
  v := public.check_when_others_timeout_blind();
  IF jsonb_array_length(v) <> 0 THEN
    RAISE EXCEPTION 'R118: handlers still blind after the shape rule: %', v;
  END IF;
END
$mig$;

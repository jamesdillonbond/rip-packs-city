-- 2026-08-25 · rpc-ccm-step2 has failed on EVERY scheduled run since 2026-08-18.
--
-- ⛔ THE FILED ROOT CAUSE WAS WRONG. It was recorded as disk-IO saturation
-- collateral, under a bar on re-investigating pg_cron statement-timeouts. Three
-- measurements refute that for this job:
--
--   * 8-for-8 failed since 08-18, across TWO different clock windows (it was
--     moved 04:25Z → 23:25Z on 08-22 and failed identically in both).
--   * The durations are bimodal with nothing between: successes 9.2 / 9.7 /
--     13.1 s, failures 300.0 / 300.0 / 300.0 / 300.1 / 300.1 / 300.3 / 303.2 s —
--     the timeout, exactly. Contention takes a 10 s query to 40 s, not to >300 s
--     for eight consecutive days.
--   * The monitor's own spell control read io_wait=0 at the time of a failure.
--
-- 🚨 THE MEASURED CAUSE: THE COHORT *IS* THE TABLE. The 220 wallets in
-- cross_collection_cohort_mat hold 1,363,128 of the 1,888,824 Top Shot rows in
-- wallet_moments_cache — 72.2 % of the partition. (Free to measure: cohort_mat
-- already carries ts_moments per wallet.) The planner estimates that join at
-- 664,888 — 2.05× under — so it picks a Nested Loop of 220 index descents into a
-- 927 MB table where ONE sequential pass is the right shape. A single-wallet
-- EXPLAIN corroborates: 20,559 actual rows against an estimate of 3,022.
--
-- ✅ MEASURED A/B at a quiet hour (io_waiters 2, active 3), buffers not seconds:
--
--     hash join (this change)  COLD:  122,524 shared buffers, actual rows
--                                     1,364,074, Execution Time 28,399 ms
--     nested loop (as shipped) WARM:  did NOT complete — still running at 140 s
--                                     when the client gave up, having had the
--                                     table warmed by the run above
--
--   ⚠ The nested loop's exact cost is UNMEASURED because it never completes;
--   contention also arrived during that run, so its 140 s is not cleanly
--   attributable. What IS established is the half that decides this: the hash
--   plan finishes COLD in 28 s, comfortably inside the job's 300 s budget, and
--   the nested loop has not finished inside 300 s in eight nightly attempts.
--   The predicted cardinality (1,363,128) matched the actual (1,364,074) to
--   0.07 %, so the mechanism is confirmed by the run, not just by the estimate.
--
-- THE CHANGE: one statement. SET LOCAL enable_nestloop = off before the
-- aggregate. Zero behaviour change — identical rows, identical output, identical
-- computed_at contract; every assertion in
-- supabase/tests/refresh_cross_collection_cohort_step2.sql still holds.
--
-- ⚠ Why a BODY statement and not a function-level SET: this repo has a recorded
-- burn that a function-level `SET statement_timeout` in proconfig is INERT (the
-- statement is already running when it applies) — see the `300s` above, which is
-- why the pg_cron job carries its own `SET statement_timeout` prefix. A planner
-- GUC would in fact take effect from proconfig, but a body-level SET LOCAL is
-- legible, provably applies before the next statement is planned, and reverts at
-- COMMIT. pg_cron and PostgREST each give this function its own transaction.
--
-- ⚠ NOT CHANGED: the 300 s timeout. The rule is cut the query's work, never
-- raise the timeout — and at 28 s the budget is no longer the constraint.

-- anon-exec: intentional — refresh_cross_collection_cohort_step2 is REPLACED, not created, and
-- CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would CHANGE
-- production rather than preserve it. The existing revoke is intact and was
-- verified LIVE with has_function_privilege rather than read off the acl text
-- (2026-08-25): anon EXECUTE = false, authenticated EXECUTE = false, service_role
-- EXECUTE = true. check_secdef_anon_exec_drift() re-run after applying.

CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_set_count int := 0;
  v_started timestamptz := NOW();
BEGIN
  -- The cohort is 72% of the Top Shot partition of wallet_moments_cache
  -- (1,363,128 of 1,888,824 rows), but the planner estimates the join at
  -- 664,888 and picks a Nested Loop: 220 separate index descents into a 927 MB
  -- table. That timed out at 300s on every nightly run from 2026-08-18.
  -- One sequential pass measures 122,524 buffers / 28s COLD. Transaction-scoped.
  SET LOCAL enable_nestloop = off;

  CREATE TEMP TABLE _ccm_step2_next ON COMMIT DROP AS
  SELECT
    e.set_id,
    MAX(e.set_name) AS set_name,
    COUNT(DISTINCT w.wallet_address) AS cohort_holders,
    COUNT(*) AS moments_in_cohort
  FROM public.cross_collection_cohort_mat c
  JOIN wallet_moments_cache w
    ON w.wallet_address = c.wallet_address
   AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN editions e
    ON e.external_id::text = w.edition_key
   AND e.collection_id = w.collection_id
  WHERE e.set_id IS NOT NULL
    AND e.set_name IS NOT NULL
  GROUP BY e.set_id;

  TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;

  INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
  SELECT set_id, set_name, cohort_holders, moments_in_cohort, v_started
  FROM _ccm_step2_next;

  GET DIAGNOSTICS v_set_count = ROW_COUNT;
  RETURN jsonb_build_object('set_overlap_rows', v_set_count, 'computed_at', v_started);
END;
$function$;

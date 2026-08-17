-- audit_20260817_mark_get_unmapped_resolver_targets_orphan_my_own_change_was_a_noop
--
-- ⛔ RETRACTION OF THE MIGRATION APPLIED ~1 HOUR EARLIER TODAY.
-- 20260817143606_audit_20260817_unmapped_resolver_targets_rotate_and_priced_only
-- changed public.get_unmapped_resolver_targets to rotate on last_onchain_attempt_at and to
-- filter price_usd > 0. That change is CORRECT ON ITS OWN TERMS and is a **NO-OP IN
-- PRODUCTION**, because NOTHING CALLS THIS FUNCTION. Its header's causal story -- "the
-- resolver re-scanned the same December slice every 30 min", "live inflow outpaced outflow" --
-- is WRONG. It described properties of the function's OUTPUT and then asserted, without ever
-- checking, that a caller was consuming it. No caller exists.
--
-- EVIDENCE (2026-08-17, four independent checks):
--   1. pg_stat_statements: ZERO calls. The only statements mentioning this function are my own
--      DDL and probes. The window is 2026-08-12 01:34Z -> now (5.6 days) and
--      pg_stat_statements_info.dealloc = 0, so NOTHING has been evicted -- the absence is a
--      real absence, not a truncated window. A PostgREST rpc/ call or a direct SQL call would
--      both appear here as top-level statements.
--   2. No SQL-level caller: pg_proc.prosrc LIKE '%get_unmapped_resolver_targets%' matches only
--      the function itself. (This check matters BECAUSE pg_stat_statements.track = top would
--      hide a nested caller -- so pgss alone would NOT have been sufficient.)
--   3. No cron.job command references it; no view or matview definition references it.
--   4. Repo grep across the whole tree (Vercel routes AND supabase/functions): no reference.
--
-- CORROBORATION FROM A FIFTH ANGLE: unmapped_sales_resolution_failures is **entirely empty**
-- (0 rows, all collections). This function's `NOT EXISTS (... retry_count >= 5 ...)` guard has
-- therefore never excluded anything. Dead code inside dead code.
--
-- ⚠ WHAT ACTUALLY RESOLVES ALLDAY SALES, and where the real constraint is:
--   * pipeline `allday-unmapped-resolver` (~3 runs/hour) loads candidates by its OWN path and
--     stamps attempts via stamp_unmapped_onchain_attempt -- 485 PostgREST calls in the same
--     5.6-day window, i.e. that RPC is live and this one is not.
--   * pipeline `promote_unmapped_sales` is what sets unmapped_sales.resolved_at (outflow).
--   * Its dominant failure is `resolve:upstream request timeout` -- 30+ occurrences in 26 h,
--     at the SAME rate before and after 14:36Z. Candidate quality was never the binding
--     constraint; the UPSTREAM is.
--   * Its runs skip a near-constant 36-37 rows every single time, in both eras. That floor is
--     unexplained and is the next thing worth diagnosing. It is NOT explained by the failure
--     table (empty, see above).
--
-- ⚠ AND THE "EARLY OUTFLOW SIGNAL" I REPORTED IS WITHDRAWN. I reported ~82 resolutions/hour
-- after the change against a ~14/hour baseline. Minute-level detail: 35 of those landed at
-- 14:16Z -- BEFORE the 14:36:06Z apply -- and 40 more at 14:36Z from a run already in flight.
-- The hour after the change produced 1. The comparison was also a burst hour against a mean
-- taken over mostly-idle hours; pre-change hours of 56, 39, 28 and 25 exist in the same series.
-- This is the same skewed-mean error made earlier this session on pack-EV cost.
--
-- ⚠ NOT REVERTING 20260817143606. Reverting an uncalled function is equally a no-op and would
-- only add churn to the migration history. The change is left in place; this comment is the
-- correction. If a caller is ever added, the rotated + priced-only form is the better one --
-- it measured 8.19 s vs a 25 s timeout for the old shape.
--
-- ⚠ DO NOT "OPTIMISE" THIS FUNCTION AGAIN without first proving a caller exists. Checking
-- pg_stat_statements alone is insufficient (track = top). Check prosrc, cron.job.command,
-- view definitions and the repo too -- all four.
-- -----------------------------------------------------------------------------

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_unmapped_resolver_targets'
  ) THEN
    RAISE EXCEPTION 'get_unmapped_resolver_targets not found -- aborting';
  END IF;
END
$guard$;

COMMENT ON FUNCTION public.get_unmapped_resolver_targets(uuid, integer, integer) IS
'ORPHAN as of 2026-08-17: zero calls in pg_stat_statements over 2026-08-12 01:34Z -> 2026-08-17 15:40Z with dealloc=0 (nothing evicted), no pg_proc.prosrc caller, no cron.job command, no view definition, no repo reference. unmapped_sales_resolution_failures is also empty, so this function''s retry-exclusion guard has never excluded a row. The live AllDay path is pipeline allday-unmapped-resolver (own candidate query + stamp_unmapped_onchain_attempt) with promote_unmapped_sales setting resolved_at; its binding constraint is resolve:upstream request timeout, not candidate quality. Migration 20260817143606 rotated and priced-filtered this function on a false premise that a caller was consuming it -- correct in itself, no-op in production. DO NOT re-optimise without proving a caller exists: pg_stat_statements alone is insufficient because track = top hides nested callers.';

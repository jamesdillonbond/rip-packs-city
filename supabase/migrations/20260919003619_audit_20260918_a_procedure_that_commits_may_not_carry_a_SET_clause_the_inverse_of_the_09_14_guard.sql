-- audit_20260918_a_procedure_that_commits_may_not_carry_a_SET_clause_the_inverse_of_the_09_14_guard
--
-- ⚠ SUPERSEDED THE SAME MINUTE by 20260919003741, which corrects this file's PREDICATE.
-- The file is kept because it was APPLIED, and because its defect is the instructive part:
-- the predicate below matches `p.prosrc` RAW, so it flagged a procedure whose only
-- `commit` is inside a comment reading "⛔ Do NOT add COMMIT here". See that migration.
--
-- WHY: THIS CLASS HAS NOW RECURRED THREE TIMES IN THREE MONTHS, AND THE GUARD ADDED
-- FOR IT COVERS THE OTHER DIRECTION.
--
--   2026-08-22/23  pinned `search_path` on `reconcile_all_saved_wallet_stats`; reverted.
--                  Register R14 closed it WONTFIX with the words "do NOT re-attempt".
--   2026-09-13/14  `20260914053000` pinned all four unpinned routines; pg_cron jobid 259
--                  failed its FIRST tick in 0.5 s with `invalid transaction termination`;
--                  `20260914055000` reverted the two procedures 20 minutes later.
--   2026-09-18     I pinned `rpc_trust_health_precompute_refresh_p()` anyway, running
--                  verbatim the statement the 09-14 header names as the thing not to do.
--                  Self-reverted in `20260919002535`.
--
-- A WONTFIX carrying "do not re-attempt" did not stop the third attempt. A note is not
-- a guard.
--
-- ── WHY THE EXISTING GUARD CANNOT CATCH IT ──────────────────────────────────────────
-- `check_function_search_path_drift()` (2026-09-14) is a ban-at-zero on FUNCTIONS that
-- are MISSING a pin, and it excludes procedures by `prokind = 'f'` — correctly, because
-- the property is not true of them. The recurring defect is the INVERSE: a PROCEDURE that
-- does transaction control and HAS a pin. Nothing asserted that direction.
--
-- ── THE RULE, WHICH IS POSTGRES' AND NOT THIS REPO'S ────────────────────────────────
-- A routine with an attached `SET` clause runs its body inside an implicit transaction
-- block, so it may not execute `COMMIT` or `ROLLBACK` — `2D000 invalid transaction
-- termination` at the first one. This binds ANY configuration parameter, not just
-- `search_path`, so the guard keys on `proconfig IS NOT NULL`.
--
-- REVERT: DROP FUNCTION public.check_procedure_transaction_control_pin_drift();

CREATE OR REPLACE FUNCTION public.check_procedure_transaction_control_pin_drift()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', 'procedure_with_transaction_control_is_pinned',
           'object_name', (p.oid::regprocedure)::text,
           'proconfig', to_jsonb(p.proconfig),
           'detail', 'This PROCEDURE does transaction control and carries an attached SET '
                  || 'clause. PostgreSQL raises 2D000 invalid transaction termination at '
                  || 'its first COMMIT. Fix with ALTER PROCEDURE ... RESET search_path.'
         ) ORDER BY (p.oid::regprocedure)::text), '[]'::jsonb)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'p'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     AND p.prosrc ~* '\mcommit\M|\mrollback\M'
     AND p.proconfig IS NOT NULL;
$function$;

-- anon-exec: NOT intentional for check_procedure_transaction_control_pin_drift — ops-only guard, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.check_procedure_transaction_control_pin_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_procedure_transaction_control_pin_drift() TO postgres, service_role;

COMMENT ON FUNCTION public.check_procedure_transaction_control_pin_drift() IS
  'Ban at zero: no PROCEDURE in public that does transaction control may carry an attached SET clause. SUPERSEDED by 20260919003741, which strips comments before matching.';

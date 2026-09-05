-- audit_20260904_close_the_anon_readable_audit_tables_i_created_two_hours_ago
--
-- anon-exec: creates no function. It REMOVES access (RLS on, anon/authenticated
-- revoked) from two tables this session created. Nothing gains a privilege here.
--
-- 🚨 A DEFECT I SHIPPED, CAUGHT BY THE ESTATE'S OWN SMOKE GATE ~7 MINUTES LATER,
-- AND RECORDED RATHER THAN QUIETLY PATCHED. The GHA `smoke` check on `e0e6aa7`
-- went red on `rpc:check_public_security_invariants`:
--
--   2 violation(s): rls_off_base_table:audit_20260904_ultimate_1of1_editions_created,
--                   rls_off_base_table:audit_20260904_wmc_ultimate_denorm_backup
--
-- Both were created by migrations `20260905061815` / `20260905062040` with a bare
-- `CREATE TABLE IF NOT EXISTS`, which left `relrowsecurity = false` AND left
-- `anon` holding SELECT. Measured before this fix: every one of the other ten
-- `audit_20260904_*` tables reads `rls_on = true, anon_select = false`; these two
-- read `rls_on = false, anon_select = true`. So this was not a house style I
-- misread -- it was the one rule in the migration checklist ("new public tables:
-- grant anon SELECT only and confirm RLS is ON") that I skipped while writing
-- three migrations in a row about something else.
--
-- ⚠ WHAT WAS ACTUALLY EXPOSED, stated rather than minimised: for roughly two
-- hours any anonymous caller could SELECT both tables. They contain edition ids,
-- external ids, player and set names -- all of which the public catalog already
-- serves -- plus, in the denorm backup, `wmc_id` values and the before/after
-- display fields of five holdings. No wallet address, no email, no key, no
-- balance. The exposure is small; it is recorded at full size anyway, because
-- the next reader needs to know the guard fired and what it caught, not a
-- reassurance.
--
-- ⭐ The instrument worked exactly as designed and this is its positive control:
-- the violation was introduced, deployed, detected by a hard smoke check, and
-- named with the offending object in under ten minutes.
--
-- REVERT (do not): ALTER TABLE ... DISABLE ROW LEVEL SECURITY; GRANT SELECT ... TO anon;
ALTER TABLE public.audit_20260904_ultimate_1of1_editions_created ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260904_wmc_ultimate_denorm_backup      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.audit_20260904_ultimate_1of1_editions_created FROM anon, authenticated;
REVOKE ALL ON public.audit_20260904_wmc_ultimate_denorm_backup      FROM anon, authenticated;

GRANT ALL ON public.audit_20260904_ultimate_1of1_editions_created TO postgres, service_role;
GRANT ALL ON public.audit_20260904_wmc_ultimate_denorm_backup      TO postgres, service_role;

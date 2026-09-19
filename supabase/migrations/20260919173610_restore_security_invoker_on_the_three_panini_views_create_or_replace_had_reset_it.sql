-- SELF-CORRECTION, same session, ~20 minutes after the fault. 2026-09-19 (Cowork cloud).
--
-- `CREATE OR REPLACE VIEW` RESETS reloptions that the new statement does not restate. Migration
-- 20260919172027 replaced panini_coverage_summary to add the per-edition age columns and did not
-- restate `security_invoker`, so the view silently reverted to a DEFINER view; the two
-- panini_bridge_candidate_* views created in 20260919xxxx were born the same way.
--
-- `check_public_security_invariants()` read 3 / kind `view_unexpected_definer`, naming exactly
-- those three and nothing else — a clean positive: the guard fired on the change that caused it,
-- in the same pass, before anything consumed the views.
--
-- ⭐ THE DURABLE LESSON, because this will recur on the next additive view edit: a CREATE OR
-- REPLACE VIEW that only means to add a column still rewrites the view's OPTIONS. Restate
-- `with (security_invoker = true)` in every such statement, and run
-- `select count(*) from check_public_security_invariants()` after ANY view DDL — not only after
-- a grant change, which is when it is normally remembered.
--
-- No data or column changes here; definitions are untouched.
--
-- REVERT (exact, and you would not want it):
--   alter view public.panini_coverage_summary set (security_invoker = false);
--   alter view public.panini_bridge_candidate_editions set (security_invoker = false);
--   alter view public.panini_bridge_candidate_fmv set (security_invoker = false);
--
-- Not a function: no anon-exec marker applies.

alter view public.panini_coverage_summary set (security_invoker = true);
alter view public.panini_bridge_candidate_editions set (security_invoker = true);
alter view public.panini_bridge_candidate_fmv set (security_invoker = true);
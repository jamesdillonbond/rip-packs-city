-- audit_20260728_panini_squeeze_restore_security_invoker
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260728171010, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. See docs/overnight/ledger.md 2026-07-31.

-- IMMEDIATE FIX to a regression I introduced minutes earlier in
-- audit_20260728_panini_squeeze_honest_coverage_column.
--
-- CREATE OR REPLACE VIEW does NOT preserve reloptions unless they are restated.
-- I assumed it did. The replace dropped security_invoker=on, leaving the view
-- running with owner (postgres) privileges, and check_public_security_invariants()
-- immediately reported (view_unexpected_definer, panini_squeeze_board).
--
-- Blast radius was nil: SELECT grants survived as postgres + service_role only
-- (anon holds REFERENCES, never SELECT), so the view was never anon-readable at
-- any point. This restores the declared posture regardless.
--
-- RULE FOR NEXT TIME: any CREATE OR REPLACE VIEW on this project must either
-- restate WITH (security_invoker=on) inline, or be followed by this ALTER in the
-- same migration -- and must end by reading check_public_security_invariants().
--
-- REVERT: ALTER VIEW public.panini_squeeze_board RESET (security_invoker);
--         (do not actually do this -- it re-breaks the invariant)

ALTER VIEW public.panini_squeeze_board SET (security_invoker = on);

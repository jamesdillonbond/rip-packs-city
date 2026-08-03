-- Keep the sales_serial_supply_worst_pct arm's self-documenting `catches` text in
-- sync with audit_20260803_serial_supply_arm_aged_cohort, which moved the arm off
-- the last-24h cohort onto rows ingested 3-10 days ago. A monitoring arm whose
-- description contradicts its own predicate is a trap for the next investigator.
--
-- Done as a programmatic substring replace over pg_get_viewdef rather than a
-- hand-transcribed CREATE VIEW: the view is ~30k characters and re-typing it to
-- change one sentence risks silently altering the platform's health board. The
-- RAISE guard means a missing phrase aborts instead of rewriting blind.
--
-- ⚠ DURABLE, AND IT BIT ON THE FIRST APPLY: `CREATE OR REPLACE VIEW` does NOT
-- preserve reloptions. It silently DROPPED `security_invoker=on` from this view,
-- which flipped it to DEFINER semantics and would have tripped
-- check_public_security_invariants()'s `view_unexpected_definer` arm. Grants ARE
-- preserved (anon/authenticated stayed revoked, verified), reloptions are NOT.
-- The ALTER VIEW below is therefore load-bearing, not belt-and-braces — any
-- future CREATE OR REPLACE VIEW in this repo must re-assert security_invoker the
-- same way. Post-state verified: reloptions {security_invoker=on}, 32 arms,
-- has_table_privilege(anon|authenticated) false, security invariants 0 rows.
--
-- Revert: run the same DO block with v_old_phrase/v_new_phrase swapped, then
-- re-run the ALTER VIEW.

DO $mig$
DECLARE
  v_def  text;
  v_new  text;
  v_old_phrase text := 'Worst collection over sales ingested in the last 24h (>=200 rows, sold within 30d).';
  v_new_phrase text := 'Worst collection over sales ingested 3-10 days ago (>=200 rows, sold within 30d) -- deliberately NOT the fresh 24h cohort: a NULL serial on a just-ingested row is in-flight work that sales-serial-backfill drains (TopShot 26.7% at 6-24h -> 0.26% at 3-10d), so keying on fresh rows made this arm flap on a healthy system (see audit_20260803_serial_supply_arm_aged_cohort). A genuinely broken writer still sails past 5% in this cohort, ~3d later.';
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  IF position(v_old_phrase in v_def) = 0 THEN
    RAISE EXCEPTION 'expected phrase not found in v_rpc_trust_health definition - aborting rather than rewriting blind';
  END IF;

  v_new := replace(v_def, v_old_phrase, v_new_phrase);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
END
$mig$;

-- Load-bearing: see the header. CREATE OR REPLACE VIEW drops reloptions.
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);

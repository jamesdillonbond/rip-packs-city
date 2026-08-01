-- audit_20260731_backlog_metric_doc_clause_order
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260731145620, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. Comment-text only -- fixes a clause-order garble introduced by
-- audit_20260731_backlog_metric_excludes_structural_collisions. No predicate
-- change, so no metric behaviour change.
-- See docs/overnight/ledger.md 2026-07-31.
--
-- Revert: reverse the o/n pair below (swap the two literals), re-run, then
-- restate security_invoker and the anon REVOKE.

DO $mig$
DECLARE
  d text;
  o text := 'excluded, AND multi-item-transaction rows that idx_sales_tx_hash makes structurally unstorable excluded (they can never be drained by any resolver; measured separately in v_sales_tx_collision_loss) (e.g. accepted AllDay April V1 tail) so this signals';
  n text := 'excluded (e.g. accepted AllDay April V1 tail), AND multi-item-transaction rows that idx_sales_tx_hash makes structurally unstorable excluded (they can never be drained by any resolver -- measured separately in v_sales_tx_collision_loss), so this signals';
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO d;
  IF position(o in d) = 0 THEN
    RAISE EXCEPTION 'abort: doc fragment not found verbatim';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || replace(d, o, n);
END
$mig$;

ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
REVOKE ALL ON public.v_rpc_trust_health FROM anon;

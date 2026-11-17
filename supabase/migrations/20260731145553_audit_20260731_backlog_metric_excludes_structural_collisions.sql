-- audit_20260731_backlog_metric_excludes_structural_collisions
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260731145553, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. This is a LIVE change to what unmapped_resolution_backlog_max
-- pages on. See docs/overnight/ledger.md 2026-07-31.
--
-- Revert: re-apply the prior v_rpc_trust_health body by reversing the two
-- replace() pairs below (swap new_pred/old_pred and new_doc/old_doc), then
-- restate `ALTER VIEW ... SET (security_invoker = on)` and the anon REVOKE.

DO $mig$
DECLARE
  d        text;
  old_pred text := 'WHERE us.resolved_at IS NULL AND COALESCE(us.price_usd, 0::numeric) > 0::numeric AND us.sold_at > (now() - ''30 days''::interval) AND us.sold_at < (now() - ''24:00:00''::interval)';
  new_pred text;
  old_doc  text := '-> sales undercount; aged residual excluded';
  new_doc  text := '-> sales undercount; aged residual excluded, AND multi-item-transaction rows that idx_sales_tx_hash makes structurally unstorable excluded (they can never be drained by any resolver; measured separately in v_sales_tx_collision_loss)';
BEGIN
  new_pred := old_pred || ' AND COALESCE((us.resolution_hint ->> ''promote_blocked''::text), ''''::text) <> ''sales_tx_hash_unique_collision''::text';

  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO d;

  IF (SELECT count(*) FROM regexp_matches(d, 'FROM unmapped_sales us', 'g')) <> 1 THEN
    RAISE EXCEPTION 'abort: expected exactly 1 unmapped_sales branch, found %',
      (SELECT count(*) FROM regexp_matches(d, 'FROM unmapped_sales us', 'g'));
  END IF;
  IF position(old_pred in d) = 0 THEN
    RAISE EXCEPTION 'abort: backlog predicate not found verbatim -- view changed since inspection';
  END IF;
  IF position(old_doc in d) = 0 THEN
    RAISE EXCEPTION 'abort: backlog description fragment not found verbatim';
  END IF;

  d := replace(d, old_pred, new_pred);
  d := replace(d, old_doc,  new_doc);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || d;
END
$mig$;

-- CREATE OR REPLACE VIEW drops reloptions and re-attaches Supabase's default
-- anon grant. Restate both, every time. (ALTER, not a second REPLACE.)
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
REVOKE ALL ON public.v_rpc_trust_health FROM anon;

-- Approved by Trevor in chat 2026-11-15 ~7:35 PM PT ("Approve the fix").
-- v_rpc_trust_health.ufc_flow_revival_sales_30d is documented as "UFC-on-Flow sales with sold_at inside the last
-- 30 days" (revival detector, 2026-08-08). Since 2026-11-15 `sales` also carries UFC Strike sales from APTOS
-- (source 'aptos_indexer_v1'; Aptos UFC extends ufc_strike), and the 26-row seed (20261116013917) put one Aptos sale
-- (2026-10-22) inside the window, so the arm read 1 = BREACH while Flow UFC trading is still dead. This keeps the arm
-- measuring exactly what it says: Flow only. Aptos UFC volume is watched by the ufc-aptos-sales-ingest lane's pipeline_runs.
-- Built from the live definition (one exact-match replacement, asserted), columns unchanged; security_invoker re-asserted.
-- REVERT: same DO block with the two predicates swapped back, then ALTER VIEW ... SET (security_invoker = on).
DO $mig$
DECLARE
  d   text := pg_get_viewdef('public.v_rpc_trust_health'::regclass);
  old text := $q$((sales.collection = 'ufc_strike'::text) AND (sales.sold_at > (now() - '30 days'::interval)))$q$;
  new text := $q$((sales.collection = 'ufc_strike'::text) AND (sales.sold_at > (now() - '30 days'::interval)) AND (sales.source IS DISTINCT FROM 'aptos_indexer_v1'::text))$q$;
BEGIN
  IF (length(d) - length(replace(d, old, ''))) / length(old) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one ufc revival predicate in v_rpc_trust_health';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || replace(d, old, new);
END
$mig$;
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
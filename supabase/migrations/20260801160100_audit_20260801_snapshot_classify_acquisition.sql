-- Snapshot migration: public.classify_acquisition(text,text,text,text,numeric).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: classifies how a wallet acquired a moment (pack pull, purchase,
-- gift, …). The HONESTY GATE is `acquisition_method = 'unknown'` in the WHERE:
-- it only fills rows that are still unclassified, so a later, weaker scan can
-- never overwrite an already-known acquisition method or a recorded buy_price.

CREATE OR REPLACE FUNCTION public.classify_acquisition(p_nft_id text, p_wallet text, p_method text, p_confidence text DEFAULT 'flow_scan'::text, p_buy_price numeric DEFAULT NULL::numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated int;
BEGIN
  UPDATE moment_acquisitions
  SET acquisition_method = p_method,
      acquisition_confidence = p_confidence,
      buy_price = COALESCE(p_buy_price, buy_price)
  WHERE nft_id = p_nft_id
    AND wallet = p_wallet
    AND acquisition_method = 'unknown';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN json_build_object(
    'updated', v_updated > 0,
    'nft_id', p_nft_id,
    'new_method', p_method,
    'new_confidence', p_confidence
  );
END;
$function$;

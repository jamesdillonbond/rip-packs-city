ALTER TABLE public.candy_sales_unresolved ADD COLUMN IF NOT EXISTS marketplace text;
COMMENT ON COLUMN public.candy_sales_unresolved.marketplace IS
  'Venue the drain writes into sales.marketplace. NULL = magic_eden (the Magic Eden lanes never set it). Set only by candy_park_chain_sale; candy_park_unresolved_sale''s re-park on conflict never touches it.';

ALTER TABLE public.candy_collections ADD COLUMN IF NOT EXISTS chain_sig_cursor text;
ALTER TABLE public.candy_collections ADD COLUMN IF NOT EXISTS chain_checked_at timestamptz;
COMMENT ON COLUMN public.candy_collections.chain_sig_cursor IS
  'Newest Solana signature on this collection account that /api/ingest/candy-chain-sales has fully read (getSignaturesForAddress until=). Advanced only behind a complete walk whose every offer landed.';
COMMENT ON COLUMN public.candy_collections.chain_checked_at IS
  'When /api/ingest/candy-chain-sales last completed a walk of this collection account (its rotation order, oldest first).';

CREATE OR REPLACE FUNCTION public.candy_park_chain_sale(
  p_signature text, p_token_mint text, p_block_time timestamptz, p_price_sol numeric,
  p_buyer text, p_seller text, p_skip_reason text, p_marketplace text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ins AS (
    INSERT INTO public.candy_sales_unresolved
      (signature, token_mint, collection_id, block_time, price_sol, buyer, seller, skip_reason, marketplace)
    VALUES
      (p_signature, p_token_mint, '209ade70-32c5-4470-bc7c-4793d660f713'::uuid,
       p_block_time, p_price_sol, p_buyer, p_seller, p_skip_reason, p_marketplace)
    ON CONFLICT (signature, token_mint) DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM ins);
$function$;
REVOKE EXECUTE ON FUNCTION public.candy_park_chain_sale(text,text,timestamptz,numeric,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.candy_park_chain_sale(text,text,timestamptz,numeric,text,text,text,text) TO service_role;
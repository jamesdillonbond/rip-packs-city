-- Applied to prod via Supabase MCP on 2026-07-26 as
-- audit_20260726_candy_park_unresolved_sale_fn. Committed here for parity.
--
-- Park (or re-park) one unwritable Candy sale. Increments attempts on repeat so
-- a permanently-unresolvable row can be aged out by the drainer instead of
-- being retried forever. A row already closed out (resolved_at NOT NULL) is
-- left alone by the WHERE on the DO UPDATE.
--
-- REVERT: DROP FUNCTION IF EXISTS public.candy_park_unresolved_sale(text,text,timestamptz,numeric,text,text,text);

CREATE OR REPLACE FUNCTION public.candy_park_unresolved_sale(
  p_signature   text,
  p_token_mint  text,
  p_block_time  timestamptz,
  p_price_sol   numeric,
  p_buyer       text,
  p_seller      text,
  p_skip_reason text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.candy_sales_unresolved
    (signature, token_mint, collection_id, block_time, price_sol, buyer, seller, skip_reason)
  VALUES
    (p_signature, p_token_mint, '209ade70-32c5-4470-bc7c-4793d660f713'::uuid,
     p_block_time, p_price_sol, p_buyer, p_seller, p_skip_reason)
  ON CONFLICT (signature, token_mint) DO UPDATE
     SET attempts        = public.candy_sales_unresolved.attempts + 1,
         last_attempt_at = now(),
         skip_reason     = EXCLUDED.skip_reason
   WHERE public.candy_sales_unresolved.resolved_at IS NULL;
$$;

-- A new function's default EXECUTE grant is to PUBLIC, which keeps
-- has_function_privilege('anon', ...) true even after revoking the role rows --
-- revoke BOTH (see the SECDEF anon-grant lesson in CLAUDE.md).
REVOKE EXECUTE ON FUNCTION public.candy_park_unresolved_sale(text,text,timestamptz,numeric,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.candy_park_unresolved_sale(text,text,timestamptz,numeric,text,text,text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.candy_park_unresolved_sale(text,text,timestamptz,numeric,text,text,text) TO service_role;

-- audit_20261121_candy_sales_buyer_paid
--
-- Candy `sales` move from the LISTED price to WHAT THE BUYER PAID (Trevor, 2026-11-21:
-- "Switch to buyer-paid" → "we need to fix this first"). A Magic Eden listing bought outright
-- costs the buyer the listed price + the creator royalty + ME's 2% fee (~12%, read on-chain on
-- 12 sales, 8 sets); a sale into a buyer's pool costs the buyer exactly the listed price. The
-- price is read per transaction by /api/ingest/candy-sales-buyer-paid (lib/candy/sale-buyer-paid.ts).
--
-- candy_sale_buyer_paid is BOTH the marker (a sale with a row here is done, never re-priced) and
-- the revert record (`ratio` and `listed_sol` restore the listed price exactly). A row with
-- `error` set left its sale at the listed price.
--
-- Revert: UPDATE public.sales s SET price_native = b.listed_sol, price_usd = round(s.price_usd / b.ratio, 2)
--   FROM public.candy_sale_buyer_paid b WHERE b.applied_at IS NOT NULL AND s.collection_id =
--   '209ade70-32c5-4470-bc7c-4793d660f713' AND s.transaction_hash = b.transaction_hash AND
--   s.nft_id = b.nft_id AND s.sold_at = b.sold_at; then DROP the two functions and the table.

CREATE TABLE IF NOT EXISTS public.candy_sale_buyer_paid (
  transaction_hash text NOT NULL,
  nft_id text NOT NULL,
  sold_at timestamptz NOT NULL,
  listed_sol numeric NOT NULL,
  ratio numeric,
  paid_by text CHECK (paid_by IN ('buyer', 'seller')),
  extras_sol numeric,
  error text,
  read_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  PRIMARY KEY (transaction_hash, nft_id),
  CHECK (ratio IS NULL OR (ratio >= 1 AND ratio <= 1.25))
);
ALTER TABLE public.candy_sale_buyer_paid ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_sale_buyer_paid FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.candy_sale_buyer_paid TO service_role;
COMMENT ON TABLE public.candy_sale_buyer_paid IS
  'Per Candy sale: the on-chain buyer-paid price as a ratio over the listed price (Magic Eden activity price), applied to sales.price_native/price_usd once (applied_at). paid_by=buyer: royalty + ME fee paid on top by the buyer; seller: paid out of the seller''s proceeds (pool fills). error: not applied, sale stays at listed price. Revert record: listed_sol, ratio. Writer: /api/ingest/candy-sales-buyer-paid (2026-11-21).';

-- Candy Magic Eden sales not yet priced, newest first.
CREATE OR REPLACE FUNCTION public.candy_buyer_paid_targets(p_limit integer)
RETURNS TABLE (transaction_hash text, nft_id text, sold_at timestamptz, price_native numeric, buyer_address text, seller_address text)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT s.transaction_hash::text, s.nft_id::text, s.sold_at, s.price_native, s.buyer_address::text, s.seller_address::text
  FROM public.sales s
  WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    AND s.marketplace = 'magic_eden'
    AND s.currency = 'SOL'
    AND s.price_native > 0
    AND s.transaction_hash IS NOT NULL
    AND s.nft_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.candy_sale_buyer_paid b
      WHERE b.transaction_hash = s.transaction_hash AND b.nft_id = s.nft_id
    )
  ORDER BY s.sold_at DESC
  LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION public.candy_buyer_paid_targets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_buyer_paid_targets(integer) TO service_role;

-- Record each reading and, the FIRST time a sale is recorded without an error, re-price it by the
-- ratio. ON CONFLICT DO NOTHING + FOUND makes a re-offered row a no-op, so a sale is never
-- multiplied twice. Returns the number of sales re-priced.
CREATE OR REPLACE FUNCTION public.candy_apply_buyer_paid(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r jsonb;
  n integer := 0;
  c integer;
  v_ratio numeric;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_ratio := NULLIF(r->>'ratio', '')::numeric;
    INSERT INTO public.candy_sale_buyer_paid (transaction_hash, nft_id, sold_at, listed_sol, ratio, paid_by, extras_sol, error, applied_at)
    VALUES (
      r->>'transaction_hash', r->>'nft_id', (r->>'sold_at')::timestamptz, (r->>'listed_sol')::numeric,
      v_ratio, NULLIF(r->>'paid_by', ''), NULLIF(r->>'extras_sol', '')::numeric, NULLIF(r->>'error', ''),
      CASE WHEN v_ratio IS NOT NULL THEN now() END
    )
    ON CONFLICT (transaction_hash, nft_id) DO NOTHING;
    IF FOUND AND v_ratio IS NOT NULL AND v_ratio <> 1 THEN
      UPDATE public.sales s
      SET price_native = round(s.price_native * v_ratio, 8),
          price_usd = round(s.price_usd * v_ratio, 2)
      WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
        AND s.transaction_hash = r->>'transaction_hash'
        AND s.nft_id = r->>'nft_id'
        AND s.sold_at = (r->>'sold_at')::timestamptz;
      GET DIAGNOSTICS c = ROW_COUNT;
      IF c = 0 THEN
        -- Recorded, but nothing re-priced: say so on the row rather than claim it applied.
        UPDATE public.candy_sale_buyer_paid
        SET applied_at = NULL, error = 'sale_row_not_found'
        WHERE transaction_hash = r->>'transaction_hash' AND nft_id = r->>'nft_id';
      ELSE
        n := n + c;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.candy_apply_buyer_paid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_apply_buyer_paid(jsonb) TO service_role;

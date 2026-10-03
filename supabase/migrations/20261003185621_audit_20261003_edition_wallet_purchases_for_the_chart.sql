-- 2026-10-03 beta feedback 10263 (edition page FMV chart: "plot user's own
-- purchases (price + date) as dots"). Trevor: "Do everything mentioned."
--
-- One read: the sales of THIS edition whose buyer is the wallet the viewer
-- tracks, as (sold_at, price_usd, serial_number, marketplace), newest first,
-- optionally bounded to the last p_days. It is a per-wallet read of a public
-- fact (every sale is on-chain), served only through the service-role route
-- (app/api/entity/edition?part=wallet-purchases) which validates the wallet
-- shape first; anon has no EXECUTE.
--
-- Address rule (lib/address.ts): a Flow/EVM hex address is case-INsensitive
-- (compared lowercased); anything else (Solana base58) is case-SENSITIVE and
-- compared verbatim — never lowercased, which would destroy it.
--
-- #142 serial refusal, the same shape as get_edition_recent_sales: a sale
-- whose serial exceeds max(edition circulation, base + parallels total) is
-- an impossible row for this edition and is refused.
--
-- Pinnacle (pinnacle_sales) is served by its own chart and is out of scope:
-- the function answers [] for it rather than guessing a join.
--
-- Revert: DROP FUNCTION public.get_edition_wallet_purchases(uuid, text, text, integer);

CREATE OR REPLACE FUNCTION public.get_edition_wallet_purchases(p_collection_id uuid, p_route_slug text, p_wallet text, p_days integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_wallet        text := btrim(coalesce(p_wallet, ''));
  v_hex           boolean;
  v_cutoff        timestamptz := CASE WHEN coalesce(p_days, 0) <= 0 THEN '-infinity'::timestamptz
                                      ELSE now() - (LEAST(p_days, 4000) || ' days')::interval END;
  result jsonb;
BEGIN
  IF v_wallet = '' OR p_collection_id = v_pinnacle_uuid THEN
    RETURN '[]'::jsonb;
  END IF;
  v_hex := v_wallet ~* '^0x[0-9a-f]+$';

  WITH ed AS (
    SELECT id, external_id, circulation_count FROM editions
    WHERE collection_id = p_collection_id
      AND (external_id = p_route_slug OR id::text = p_route_slug)
    LIMIT 1
  ),
  rows_ AS (
    SELECT s.sold_at, s.price_usd, s.serial_number, s.marketplace
    FROM ed
    JOIN sales s ON s.edition_id = ed.id
    WHERE s.sold_at >= v_cutoff
      AND s.price_usd IS NOT NULL AND s.price_usd > 0
      AND s.buyer_address IS NOT NULL
      AND CASE WHEN v_hex THEN lower(s.buyer_address) = lower(v_wallet)
               ELSE s.buyer_address = v_wallet END
      AND (s.serial_number IS NULL
           OR ed.circulation_count IS NULL OR ed.circulation_count <= 0
           OR s.serial_number <= ed.circulation_count
           OR s.serial_number <= (
                SELECT sum(e2.circulation_count) FROM editions e2
                WHERE e2.collection_id = p_collection_id
                  AND e2.circulation_count > 0
                  AND split_part(e2.external_id, '::', 1) = split_part((SELECT external_id FROM ed), '::', 1)))
    ORDER BY s.sold_at DESC
    LIMIT 500
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(rows_.*) ORDER BY rows_.sold_at DESC), '[]'::jsonb)
  INTO result
  FROM rows_;

  RETURN result;
END
$function$;

-- anon-exec: NOT granted — a per-wallet read served only through the service-role route (get_edition_wallet_purchases).
REVOKE ALL ON FUNCTION public.get_edition_wallet_purchases(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_edition_wallet_purchases(uuid, text, text, integer) TO postgres, service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.get_edition_wallet_purchases(uuid, text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute get_edition_wallet_purchases';
  END IF;
  IF public.get_edition_wallet_purchases('95f28a17-224a-4025-96ad-adf8a4c63bfd', '272:9030', '', 0) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'an empty wallet must answer []';
  END IF;
END
$verify$;

-- DB invariant: public.get_pinnacle_wallet_best_offer_total — sums the best
-- (MAX) standing DapperOffersV2 bid per Pinnacle pin a wallet holds, from the
-- collection-agnostic on-chain offer feed marketplace_offers (nft_id = the pin's
-- moment_id; DUC ~= USD; offer_state='LISTED' == a live standing offer). Powers
-- the Pinnacle wallet best-offer tile (/api/pinnacle-wallet). This pins the four
-- filters that keep the total honest — LISTED-only, DUC-only, offer_price>0, and
-- the double collection scope (both the held-pins side AND the offers side must
-- be the Pinnacle collection) — plus wallet scoping, MAX-per-pin, and rounding.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260724234035_audit_20260724_pinnacle_wallet_best_offer_total.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal fixtures — only the columns the function reads.
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, moment_id text);
CREATE TABLE public.marketplace_offers (
  collection_id uuid, nft_id text, offer_state text, currency text, offer_price numeric);

-- Pinnacle = 7dd9dd11-… (hardcoded in the fn); a foreign collection = Top Shot.
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id) VALUES
  ('0xheld',  '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinA'),
  ('0xheld',  '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinB'),
  ('0xheld',  '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinC'),   -- only a $0 offer → ignored
  ('0xheld',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'pinTS'),  -- held but WRONG collection in wmc → not a Pinnacle holding
  ('0xother', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinX'),   -- a different wallet's pin
  ('0xround', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinR');

INSERT INTO public.marketplace_offers (collection_id, nft_id, offer_state, currency, offer_price) VALUES
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinA', 'LISTED',    'DUC',  10.00),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinA', 'LISTED',    'DUC',  15.50),  -- MAX for pinA
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinA', 'LISTED',    'DUC',  12.00),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'pinA', 'LISTED',    'DUC', 500.00),  -- WRONG collection on the offer → ignored
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinB', 'LISTED',    'DUC',  20.00),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinB', 'CANCELLED', 'DUC',  99.00),  -- not LISTED → ignored
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinB', 'LISTED',    'FLOW', 88.00),  -- not DUC → ignored
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinC', 'LISTED',    'DUC',   0.00),  -- not > 0 → ignored
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinX', 'LISTED',    'DUC',  50.00),  -- 0xother's holding
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'pinR', 'LISTED',    'DUC',  10.129), -- rounds to 10.13
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'ghost','LISTED',    'DUC',  33.00);  -- offer on a pin nobody holds → ignored

-- >>> BEGIN verbatim get_pinnacle_wallet_best_offer_total (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_pinnacle_wallet_best_offer_total(p_wallet text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH held AS (
    SELECT wmc.moment_id
    FROM wallet_moments_cache wmc
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
  ),
  best AS (
    SELECT mo.nft_id, MAX(mo.offer_price) AS best_offer
    FROM marketplace_offers mo
    JOIN held h ON h.moment_id = mo.nft_id
    WHERE mo.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
      AND mo.offer_state = 'LISTED'
      AND mo.currency = 'DUC'
      AND mo.offer_price > 0
    GROUP BY mo.nft_id
  )
  SELECT ROUND(COALESCE(SUM(best_offer), 0), 2) FROM best;
$function$;
-- <<< END verbatim get_pinnacle_wallet_best_offer_total <<<

-- 0xheld: pinA MAX(15.50) + pinB(20.00) = 35.50. Everything else about pinA/pinB/pinC
-- exercises one filter: the 500.00 offer is a foreign collection, pinB's 99.00 is
-- CANCELLED and its 88.00 is FLOW, pinC's only offer is $0, pinTS is held under the
-- wrong collection, and the 'ghost' offer is on an unheld pin.
SELECT _assert_eq(
  public.get_pinnacle_wallet_best_offer_total('0xheld')::text,
  '35.50', '0xheld → MAX-per-pin over LISTED+DUC+>0, both-sides collection-scoped');

-- Wallet scoping: pinX's $50 offer belongs to 0xother, and must not leak into 0xheld.
SELECT _assert_eq(
  public.get_pinnacle_wallet_best_offer_total('0xother')::text,
  '50.00', '0xother → only its own held pin counts');

-- A wallet that holds nothing → 0.00 (COALESCE, never NULL).
SELECT _assert_eq(
  public.get_pinnacle_wallet_best_offer_total('0xnobody')::text,
  '0.00', 'wallet with no holdings → 0.00');

-- ROUND to cents.
SELECT _assert_eq(
  public.get_pinnacle_wallet_best_offer_total('0xround')::text,
  '10.13', '0xround → 10.129 rounds to 10.13');

SELECT '✓ get_pinnacle_wallet_best_offer_total: all 4 assertions passed' AS result;

ROLLBACK;

-- DB invariant: public.get_wallet_best_offer_total — the collection-agnostic
-- best-offer aggregate behind the AI concierge check_wallet "standing offers on
-- your holdings" figure. Sums the MAX standing DapperOffersV2 bid per held moment
-- across ALL collections, from marketplace_offers (nft_id = moment_id; DUC ~= USD;
-- offer_state='LISTED'). This pins the honesty filters (LISTED-only, DUC-only,
-- offer_price>0), the COMPOSITE (collection_id, moment_id) join key — a moment id
-- can repeat across collections, so joining on nft_id alone would cross-credit —
-- plus wallet scoping, MAX-per-moment, empty->0.00, and rounding.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260725003941_audit_20260725_get_wallet_best_offer_total.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, moment_id text);
CREATE TABLE public.marketplace_offers (
  collection_id uuid, nft_id text, offer_state text, currency text, offer_price numeric);

-- Two collections: Top Shot (95f2…) and All Day (dee2…).
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id) VALUES
  ('0xheld',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm1'),   -- TS
  ('0xheld',  'dee28451-5d62-409e-a1ad-a83f763ac070', 'm1'),   -- AllDay, SAME moment_id string as the TS pin
  ('0xheld',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm2'),
  ('0xheld',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm3'),   -- only a $0 offer → ignored
  ('0xother', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mX'),
  ('0xround', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mR');

INSERT INTO public.marketplace_offers (collection_id, nft_id, offer_state, currency, offer_price) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm1', 'LISTED',    'DUC',  10.00),  -- TS m1
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm1', 'LISTED',    'DUC',  15.50),  -- MAX for TS m1
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'm1', 'LISTED',    'DUC',  40.00),  -- AllDay m1 (same id, DIFFERENT collection)
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm2', 'LISTED',    'DUC',  20.00),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm2', 'CANCELLED', 'DUC',  99.00),  -- not LISTED → ignored
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm2', 'LISTED',    'FLOW', 88.00),  -- not DUC → ignored
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm3', 'LISTED',    'DUC',   0.00),  -- not > 0 → ignored
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mX', 'LISTED',    'DUC',  50.00),  -- 0xother's
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mR', 'LISTED',    'DUC',  10.129), -- rounds to 10.13
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ghost','LISTED',  'DUC',  33.00);  -- offer on a pin nobody holds → ignored

-- >>> BEGIN verbatim get_wallet_best_offer_total (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_best_offer_total(p_wallet text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH held AS (
    SELECT wmc.collection_id, wmc.moment_id
    FROM wallet_moments_cache wmc
    WHERE wmc.wallet_address = p_wallet
  ),
  best AS (
    SELECT mo.collection_id, mo.nft_id, MAX(mo.offer_price) AS best_offer
    FROM marketplace_offers mo
    JOIN held h ON h.collection_id = mo.collection_id AND h.moment_id = mo.nft_id
    WHERE mo.offer_state = 'LISTED'
      AND mo.currency = 'DUC'
      AND mo.offer_price > 0
    GROUP BY mo.collection_id, mo.nft_id
  )
  SELECT ROUND(COALESCE(SUM(best_offer), 0), 2) FROM best;
$function$;
-- <<< END verbatim get_wallet_best_offer_total <<<

-- 0xheld: TS m1 MAX(15.50) + AllDay m1 (40.00, credited separately because the
-- join key is composite) + TS m2 (20.00) = 75.50. TS m3's only offer is $0.
SELECT _assert_eq(
  public.get_wallet_best_offer_total('0xheld')::text,
  '75.50', '0xheld → composite-key MAX-per-moment over LISTED+DUC+>0 (same id in 2 collections credited separately)');

-- Wallet scoping: mX's $50 belongs to 0xother.
SELECT _assert_eq(
  public.get_wallet_best_offer_total('0xother')::text,
  '50.00', '0xother → only its own held moment counts');

-- Empty → 0.00 (never NULL).
SELECT _assert_eq(
  public.get_wallet_best_offer_total('0xnobody')::text,
  '0.00', 'wallet with no holdings → 0.00');

-- ROUND to cents.
SELECT _assert_eq(
  public.get_wallet_best_offer_total('0xround')::text,
  '10.13', '0xround → 10.129 rounds to 10.13');

SELECT '✓ get_wallet_best_offer_total: all 4 assertions passed' AS result;

ROLLBACK;

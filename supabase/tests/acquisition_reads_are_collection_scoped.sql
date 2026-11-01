-- DB invariant: moment_acquisitions reads/writes are COLLECTION-scoped (#142).
--
-- moment_id / nft_id is unique only within a collection — including inside ONE
-- Flow wallet, which holds Top Shot, All Day and UFC moments whose ids collide.
-- Measured 2026-10-31: 41 wallet_moments_cache rows in 11 wallets matched an
-- acquisition from another collection; 168 sales_backfill rows were priced from
-- another collection's sale; 443 moments exported twice in the wallet CSV.
--
-- Pins three functions:
--   (a) get_wallet_acquisition_data_scoped — p_collection_id scopes the read; NULL
--       keeps the wallet-wide read (and its newest-row-per-nft rule).
--   (b) export_wallet_csv — one row per held moment (never one per acquisition
--       row), priced from the moment's OWN collection's newest acquisition.
--   (c) backfill_cost_basis_from_ids — neither its "already covered" check nor
--       its sales lookup may be satisfied by another collection.
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20261101145940_audit_20261031_get_wallet_acquisition_data_scoped.sql (a) and
-- supabase/migrations/20261101145804_audit_20261031_acquisition_writers_and_export_are_collection_scoped.sql (b, c);
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, moment_id text, edition_key text,
  player_name text, set_name text, series_number integer, tier text,
  serial_number integer, fmv_usd numeric, is_locked boolean, lock_checked_at timestamptz
);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, collection_id uuid, player_name text,
  set_name text, series integer, tier text, circulation_count integer
);
CREATE TABLE public.fmv_snapshots (edition_id uuid, fmv_usd numeric, computed_at timestamptz);
CREATE TABLE public.moment_acquisitions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, nft_id text, wallet text, buy_price numeric,
  acquired_date timestamptz, acquired_type integer, fmv_at_acquisition numeric,
  seller_address text, transaction_hash text, source text, collection_id uuid,
  acquisition_method text, loan_principal numeric, source_wallet text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX ON public.moment_acquisitions (nft_id, wallet, transaction_hash);
CREATE TABLE public.sales (
  nft_id text, price_usd numeric, sold_at timestamptz, seller_address text,
  transaction_hash text, edition_id uuid, collection_id uuid
);

\set TS '95f28a17-224a-4025-96ad-adf8a4c63bfd'
\set AD 'dee28451-5d62-409e-a1ad-a83f763ac070'

-- One wallet holds Top Shot 100 and All Day 100: the SAME id, two moments.
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, player_name) VALUES
  ('0xw', :'TS'::uuid, '100', 'TS Player'),
  ('0xw', :'AD'::uuid, '100', 'AD Player');
-- Top Shot 100 has TWO acquisition rows (an old one superseded by a newer one);
-- All Day 100 has NONE. The newest Top Shot row was created most recently, so
-- an unscoped newest-row read hands it to the All Day moment too.
INSERT INTO public.moment_acquisitions (nft_id, wallet, collection_id, buy_price, acquisition_method, transaction_hash, created_at) VALUES
  ('100', '0xw', :'TS'::uuid, 3,  'marketplace', 'tx-old', now() - interval '9 days'),
  ('100', '0xw', :'TS'::uuid, 65, 'marketplace', 'tx-new', now() - interval '1 day');

-- >>> BEGIN verbatim (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_acquisition_data_scoped(p_wallet text, p_moment_ids text[], p_collection_id uuid)
 RETURNS TABLE(moment_id text, acquisition_method text, buy_price numeric, loan_principal numeric, acquired_date timestamp with time zone, source_wallet text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (ma.nft_id)
    ma.nft_id AS moment_id,
    ma.acquisition_method,
    ma.buy_price,
    ma.loan_principal,
    ma.acquired_date,
    ma.source_wallet
  FROM moment_acquisitions ma
  WHERE ma.wallet = p_wallet
    AND ma.nft_id = ANY(p_moment_ids)
    AND (p_collection_id IS NULL OR ma.collection_id = p_collection_id)
  ORDER BY ma.nft_id, ma.created_at DESC;
$function$;

CREATE OR REPLACE FUNCTION public.export_wallet_csv(p_wallet text)
 RETURNS TABLE(player_name text, set_name text, series text, tier text, serial_number integer, circulation_count integer, fmv numeric, buy_price numeric, acquisition_method text, is_locked boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with latest_fmv as (
    select distinct on (edition_id) edition_id, fmv_usd
    from fmv_snapshots
    order by edition_id, computed_at desc
  )
  select
    coalesce(e.player_name, w.player_name)               as player_name,
    coalesce(e.set_name, w.set_name)                     as set_name,
    coalesce(w.series_number::text, e.series::text)      as series,
    coalesce(e.tier::text, w.tier)                       as tier,
    w.serial_number                                       as serial_number,
    e.circulation_count                                   as circulation_count,
    coalesce(lf.fmv_usd, w.fmv_usd)                      as fmv,
    ma.buy_price                                          as buy_price,
    ma.acquisition_method                                 as acquisition_method,
    case when w.lock_checked_at is not null then coalesce(w.is_locked, false) end as is_locked
  from wallet_moments_cache w
  left join editions e
    on e.external_id = w.edition_key
   and e.collection_id = w.collection_id
  left join latest_fmv lf on lf.edition_id = e.id
  left join lateral (
    select ma2.buy_price, ma2.acquisition_method
    from moment_acquisitions ma2
    where ma2.wallet = w.wallet_address
      and ma2.collection_id = w.collection_id
      and ma2.nft_id = w.moment_id
    order by ma2.created_at desc
    limit 1
  ) ma on true
  where w.wallet_address = lower(p_wallet);
$function$;

CREATE OR REPLACE FUNCTION public.backfill_cost_basis_from_ids(p_wallet text, p_nft_ids text[], p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_no_sale integer := 0;
  v_nft_id text;
  v_sale record;
  v_fmv numeric;
BEGIN
  FOREACH v_nft_id IN ARRAY p_nft_ids
  LOOP
    IF EXISTS (
      SELECT 1 FROM moment_acquisitions
      WHERE nft_id = v_nft_id AND wallet = p_wallet
        AND collection_id = p_collection_id
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT s.price_usd, s.sold_at, s.seller_address, s.transaction_hash, s.edition_id
    INTO v_sale
    FROM sales s
    WHERE s.nft_id = v_nft_id AND s.price_usd > 0
      AND s.collection_id = p_collection_id
    ORDER BY s.sold_at DESC LIMIT 1;

    IF v_sale IS NULL THEN
      v_no_sale := v_no_sale + 1;
      CONTINUE;
    END IF;

    SELECT fs.fmv_usd INTO v_fmv
    FROM fmv_snapshots fs
    WHERE fs.edition_id = v_sale.edition_id
    ORDER BY fs.computed_at DESC LIMIT 1;

    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, fmv_at_acquisition, seller_address, transaction_hash, source, collection_id)
    VALUES (
      v_nft_id, p_wallet, v_sale.price_usd, v_sale.sold_at, 1, v_fmv,
      v_sale.seller_address,
      COALESCE(v_sale.transaction_hash, 'backfill:' || v_nft_id),
      'sales_backfill',
      p_collection_id
    )
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN json_build_object(
    'inserted', v_inserted, 'skipped', v_skipped,
    'no_sale', v_no_sale, 'total_ids', array_length(p_nft_ids, 1)
  );
END;
$function$;
-- <<< END verbatim <<<

-- (a) get_wallet_acquisition_data_scoped
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.get_wallet_acquisition_data_scoped('0xw', ARRAY['100'], :'AD'::uuid)),
  '0', 'All Day scope: the Top Shot acquisition of the same id does not answer');
SELECT _assert_eq(
  (SELECT buy_price::text FROM public.get_wallet_acquisition_data_scoped('0xw', ARRAY['100'], :'TS'::uuid)),
  '65', 'Top Shot scope: the newest row of its own collection');
SELECT _assert_eq(
  (SELECT buy_price::text FROM public.get_wallet_acquisition_data_scoped('0xw', ARRAY['100'], NULL)),
  '65', 'NULL collection: the wallet-wide read (cost-basis with no ?collection)');

-- (b) export_wallet_csv: exactly one row per held moment, own-collection price.
SELECT _assert_eq((SELECT count(*)::text FROM public.export_wallet_csv('0xw')), '2',
  'one CSV row per held moment, never one per acquisition row');
SELECT _assert_eq(
  (SELECT buy_price::text FROM public.export_wallet_csv('0xw') WHERE player_name = 'AD Player'),
  NULL, 'the All Day moment never exports the Top Shot moment''s price');
SELECT _assert_eq(
  (SELECT buy_price::text FROM public.export_wallet_csv('0xw') WHERE player_name = 'TS Player'),
  '65', 'the Top Shot moment exports its newest acquisition');

-- (c) backfill_cost_basis_from_ids: an All Day sale of id 200 must not price
-- Top Shot 200, and an All Day acquisition of 300 must not mark Top Shot 300
-- "already covered".
INSERT INTO public.sales (nft_id, price_usd, sold_at, transaction_hash, collection_id) VALUES
  ('200', 9.5, now() - interval '3 days', 'tx-ad-200', :'AD'::uuid),
  ('300', 4.0, now() - interval '2 days', 'tx-ts-300', :'TS'::uuid);
INSERT INTO public.moment_acquisitions (nft_id, wallet, collection_id, transaction_hash) VALUES
  ('300', '0xw', :'AD'::uuid, 'tx-ad-300');
SELECT public.backfill_cost_basis_from_ids('0xw', ARRAY['200','300']) AS rb \gset
SELECT _assert_eq((:'rb'::json->>'no_sale'), '1', 'Top Shot 200 has no Top Shot sale — the All Day sale is not used');
SELECT _assert_eq((:'rb'::json->>'skipped'), '0', 'an All Day acquisition does not mark Top Shot 300 covered');
SELECT _assert_eq((:'rb'::json->>'inserted'), '1', 'Top Shot 300 is priced from its own sale');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.moment_acquisitions WHERE source = 'sales_backfill' AND nft_id = '200'),
  '0', 'no row priced from another collection''s sale');
SELECT _assert_eq(
  (SELECT buy_price::text FROM public.moment_acquisitions WHERE source = 'sales_backfill' AND nft_id = '300'),
  '4.0', 'the Top Shot sale price, tagged Top Shot');

SELECT '✓ acquisition reads are collection-scoped invariants pass' AS result;
ROLLBACK;

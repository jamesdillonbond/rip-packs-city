-- DB invariant: tg_capture_topshot_insider_marketplace_buyback (#142, 2026-11-01).
--
-- The trigger runs AFTER INSERT on sales_2026, which holds EVERY collection. It
-- must (a) record a Top Shot sale to a signal_source wallet, with its Top Shot
-- edition; (b) record NOTHING for another collection's sale to the same wallet;
-- (c) resolve the edition from the TOP SHOT cache row even when an All Day row
-- shares the moment_id; (d) skip a non-signal buyer.
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20261101160840_audit_20261101_topshot_insider_buyback_trigger_is_top_shot_scoped.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.seeded_wallets (wallet_address text, tags text[]);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.wallet_moments_cache (wallet_address text, collection_id uuid, moment_id text, edition_key text);
CREATE TABLE public.topshot_insider_buybacks (
  sale_id uuid, acquisition_method text, buyer_address text, seller_address text,
  edition_id uuid, moment_id text, serial_number integer, price_usd numeric,
  sold_at timestamptz, metadata jsonb
);
CREATE TABLE public.sales_2026 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, collection_id uuid, nft_id text,
  buyer_address text, seller_address text, price_usd numeric, sold_at timestamptz,
  transaction_hash text, marketplace text
);

\set TS '95f28a17-224a-4025-96ad-adf8a4c63bfd'
\set AD 'dee28451-5d62-409e-a1ad-a83f763ac070'

INSERT INTO public.seeded_wallets VALUES ('0xteam', ARRAY['signal_source']), ('0xfan', ARRAY['other']);
INSERT INTO public.editions VALUES
  ('e0000000-0000-0000-0000-000000000001', :'TS'::uuid, '26:505'),
  ('e0000000-0000-0000-0000-000000000002', :'AD'::uuid, '3465');
-- moment 777 exists in BOTH collections; the All Day row is inserted FIRST so an
-- unscoped LIMIT 1 tends to take it.
INSERT INTO public.wallet_moments_cache VALUES
  ('0xsomeone', :'AD'::uuid, '777', '3465'),
  ('0xteam',    :'TS'::uuid, '777', '26:505');

-- >>> BEGIN verbatim (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.tg_capture_topshot_insider_marketplace_buyback()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_signal_source boolean;
  v_edition_id uuid;
BEGIN
  IF NEW.buyer_address IS NULL THEN
    RETURN NEW;
  END IF;

  -- sales_2026 holds every collection; this table is Top Shot's (#142).
  IF NEW.collection_id IS DISTINCT FROM '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM seeded_wallets sw
    WHERE lower(sw.wallet_address) = lower(NEW.buyer_address)
      AND 'signal_source' = ANY(sw.tags)
  ) INTO v_is_signal_source;

  IF NOT v_is_signal_source THEN
    RETURN NEW;
  END IF;

  -- Resolve edition_id by joining wallet_moments_cache → editions.
  -- Best-effort; NULL is fine on no-match (the pattern detector still
  -- works with missing edition refs).
  SELECT e.id INTO v_edition_id
  FROM editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND (
      e.external_id = (
        SELECT wmc.edition_key FROM wallet_moments_cache wmc
        WHERE wmc.moment_id = NEW.nft_id
          AND wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
        LIMIT 1
      )
    )
  LIMIT 1;

  -- Skip dedup if a snapshot-diff already captured this same arrival
  -- on the same day (avoid double-counting when both detection paths
  -- agree).
  IF EXISTS (
    SELECT 1 FROM topshot_insider_buybacks b
    WHERE b.buyer_address = lower(NEW.buyer_address)
      AND b.moment_id = NEW.nft_id
      AND (b.sold_at AT TIME ZONE 'UTC')::date = (NEW.sold_at AT TIME ZONE 'UTC')::date
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO topshot_insider_buybacks (
    sale_id, acquisition_method, buyer_address, seller_address,
    edition_id, moment_id, serial_number, price_usd, sold_at, metadata
  ) VALUES (
    NEW.id,
    'marketplace',
    lower(NEW.buyer_address),
    lower(COALESCE(NEW.seller_address, '')),
    v_edition_id,
    NEW.nft_id,
    NULL,
    NEW.price_usd,
    NEW.sold_at,
    jsonb_build_object(
      'detected_via', 'sales_2026_trigger',
      'transaction_hash', NEW.transaction_hash,
      'marketplace', NEW.marketplace
    )
  );

  RETURN NEW;
END;
$function$;
-- <<< END verbatim <<<

CREATE TRIGGER trg_topshot_insider_marketplace_buyback AFTER INSERT ON public.sales_2026
  FOR EACH ROW EXECUTE FUNCTION public.tg_capture_topshot_insider_marketplace_buyback();

-- (a)+(c) a Top Shot sale to the signal wallet is recorded with the TOP SHOT edition.
INSERT INTO public.sales_2026 (collection_id, nft_id, buyer_address, price_usd, sold_at)
  VALUES (:'TS'::uuid, '777', '0xTEAM', 10, '2026-11-01T10:00:00Z');
SELECT _assert_eq((SELECT count(*)::text FROM public.topshot_insider_buybacks), '1',
  'a Top Shot sale to a signal_source wallet is recorded');
SELECT _assert_eq((SELECT edition_id::text FROM public.topshot_insider_buybacks),
  'e0000000-0000-0000-0000-000000000001', 'with the Top Shot edition, not lost to the All Day row');

-- (b) an ALL DAY sale to the same wallet is not a Top Shot buyback.
INSERT INTO public.sales_2026 (collection_id, nft_id, buyer_address, price_usd, sold_at)
  VALUES (:'AD'::uuid, '888', '0xteam', 5, '2026-11-01T11:00:00Z');
SELECT _assert_eq((SELECT count(*)::text FROM public.topshot_insider_buybacks WHERE moment_id = '888'), '0',
  'another collection''s sale never lands in topshot_insider_buybacks');

-- (d) a non-signal buyer is skipped.
INSERT INTO public.sales_2026 (collection_id, nft_id, buyer_address, price_usd, sold_at)
  VALUES (:'TS'::uuid, '999', '0xfan', 5, '2026-11-01T12:00:00Z');
SELECT _assert_eq((SELECT count(*)::text FROM public.topshot_insider_buybacks), '1',
  'a non-signal buyer is not recorded');

SELECT '✓ tg_capture_topshot_insider_marketplace_buyback invariants pass' AS result;
ROLLBACK;

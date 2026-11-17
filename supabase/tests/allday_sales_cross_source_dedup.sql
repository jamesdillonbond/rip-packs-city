-- DB invariant: public.allday_sales_cross_source_dedup — the BEFORE INSERT
-- trigger on public.sales that folds AllDay CROSS-SOURCE economic twins into one
-- row. Two ingest paths (e.g. the forward sales-indexer and a history backfill)
-- can each record the same AllDay sale under a different `source`; the economic
-- key (collection=AllDay · same nft_id · rounded price to 2dp · same calendar
-- day · DIFFERENT source) identifies the twin. When one exists the incoming row
-- is SUPPRESSED (RETURN NULL) and its buyer/seller/serial gaps are merged into
-- the surviving twin. This silently drops an insert, so a regression here either
-- double-counts an AllDay sale (fold stops firing) or destroys a genuinely
-- distinct sale (fold fires too eagerly) — both corrupt volume/FMV inputs. The
-- 2026-07-31 drainer fix depended on this classifying correctly.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260702130000_audit_20260702_allday_cross_source_dedup_writer_trigger.sql),
-- and was verified byte-identical to the live prod definition via
-- pg_get_functiondef on 2026-07-31. __tests__/db-invariants-drift-guard.test.ts
-- fails CI if the copy drifts from the migration.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal sales fixture: only the columns the trigger reads/writes (types match
-- information_schema on the live table).
CREATE TABLE public.sales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  uuid,
  nft_id         varchar,
  price_usd      numeric,
  sold_at        timestamptz,
  source         text,
  buyer_address  varchar,
  seller_address varchar,
  serial_number  integer,
  ingested_at    timestamptz
);

-- >>> BEGIN verbatim allday_sales_cross_source_dedup (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.allday_sales_cross_source_dedup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$
DECLARE
  ad_id constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  twin  record;
BEGIN
  -- Only AllDay rows carrying the fields the economic key needs.
  IF NEW.collection_id IS DISTINCT FROM ad_id
     OR NEW.nft_id IS NULL
     OR NEW.price_usd IS NULL
     OR NEW.sold_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Richest existing cross-source twin (same nft, rounded price, calendar day).
  SELECT s.id INTO twin
  FROM sales s
  WHERE s.collection_id = ad_id
    AND s.nft_id = NEW.nft_id
    AND date_trunc('day', s.sold_at) = date_trunc('day', NEW.sold_at)
    AND round(s.price_usd::numeric, 2) = round(NEW.price_usd::numeric, 2)
    AND s.source IS DISTINCT FROM NEW.source
  ORDER BY (CASE WHEN s.buyer_address  IS NOT NULL THEN 1 ELSE 0 END
          + CASE WHEN s.seller_address IS NOT NULL THEN 1 ELSE 0 END
          + CASE WHEN COALESCE(s.serial_number, 0) > 0 THEN 1 ELSE 0 END) DESC,
           s.ingested_at ASC NULLS LAST, s.id ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;  -- no cross-source twin; normal insert
  END IF;

  -- Collapse to one row: fill the surviving twin's gaps from the incoming row,
  -- then suppress the incoming insert.
  UPDATE sales s
  SET buyer_address  = COALESCE(s.buyer_address,  NEW.buyer_address),
      seller_address = COALESCE(s.seller_address, NEW.seller_address),
      serial_number  = COALESCE(NULLIF(s.serial_number, 0), NULLIF(NEW.serial_number, 0), s.serial_number)
  WHERE s.id = twin.id;

  RETURN NULL;
END
$body$;
-- <<< END verbatim allday_sales_cross_source_dedup <<<

CREATE TRIGGER trg_zzz_allday_cross_source_dedup
BEFORE INSERT ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.allday_sales_cross_source_dedup();

-- AllDay + two other collection UUIDs.
\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set ts '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

-- ── 1. Non-AllDay row inserts normally (guard: collection_id mismatch) ───────
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ts::uuid, 'x1', 10.00, '2026-07-30T12:00:00Z', 'indexer');
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id='x1'), '1',
  'non-AllDay row is never deduped — inserts normally');

-- ── 2. First AllDay sale of an nft inserts normally (no twin yet) ────────────
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source, buyer_address)
VALUES (:ad::uuid, 'ad1', 25.00, '2026-07-30T09:00:00Z', 'sales-indexer', NULL);
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id='ad1'), '1',
  'first AllDay sale of an nft — no cross-source twin, inserts normally');

-- ── 3. Cross-source economic twin is FOLDED (incoming suppressed) + gaps merged ──
-- Incoming carries a buyer the surviving twin lacks; twin has a seller the
-- incoming lacks. Rounded price matches (25.004 -> 25.00), same day, other source.
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source, buyer_address, seller_address, serial_number)
VALUES (:ad::uuid, 'ad1', 25.004, '2026-07-30T21:00:00Z', 'history-backfill', '0xBUYER', NULL, 7);
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id='ad1'), '1',
  'cross-source twin FOLDED — incoming insert suppressed, still one row');
SELECT _assert_eq((SELECT buyer_address FROM public.sales WHERE nft_id='ad1'), '0xBUYER',
  'surviving twin gained the incoming buyer (COALESCE fills the gap)');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='ad1'), '7',
  'surviving twin gained the incoming serial (0-treated-as-null)');
SELECT _assert_eq((SELECT source FROM public.sales WHERE nft_id='ad1'), 'sales-indexer',
  'the ORIGINAL (surviving) row is kept; the incoming source is the one dropped');

-- ── 4. Same-SOURCE duplicate is NOT deduped by this trigger ──────────────────
-- (source IS DISTINCT FROM NEW.source fails → no twin → normal insert.)
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ad::uuid, 'ad2', 40.00, '2026-07-30T08:00:00Z', 'sales-indexer');
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ad::uuid, 'ad2', 40.00, '2026-07-30T19:00:00Z', 'sales-indexer');
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id='ad2'), '2',
  'same-source rows are NOT folded (cross-source only) — both land');

-- ── 5. Different price / different day → not an economic twin (both land) ─────
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ad::uuid, 'ad3', 50.00, '2026-07-30T08:00:00Z', 'sales-indexer');
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ad::uuid, 'ad3', 55.00, '2026-07-30T08:00:00Z', 'history-backfill'); -- price differs
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ad::uuid, 'ad3', 50.00, '2026-07-31T08:00:00Z', 'history-backfill'); -- day differs
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id='ad3'), '3',
  'different price OR different calendar day breaks the economic key — no fold');

-- ── 6. AllDay row missing a key field passes the guard (inserts, no fold) ────
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ad::uuid, 'ad4', 12.00, '2026-07-30T08:00:00Z', 'sales-indexer');
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source)
VALUES (:ad::uuid, 'ad4', NULL, '2026-07-30T20:00:00Z', 'history-backfill'); -- NULL price → guard
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id='ad4'), '2',
  'AllDay row with NULL price_usd bypasses the dedup guard — inserts normally');

-- ── 7. The merge NEVER overwrites the surviving twin''s existing non-null values ──
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source, buyer_address, serial_number)
VALUES (:ad::uuid, 'ad5', 30.00, '2026-07-30T08:00:00Z', 'sales-indexer', '0xORIGINAL', 3);
INSERT INTO public.sales (collection_id, nft_id, price_usd, sold_at, source, buyer_address, serial_number)
VALUES (:ad::uuid, 'ad5', 30.00, '2026-07-30T20:00:00Z', 'history-backfill', '0xLATER', 9);
SELECT _assert_eq((SELECT buyer_address FROM public.sales WHERE nft_id='ad5'), '0xORIGINAL',
  'COALESCE keeps the surviving twin''s existing buyer — incoming does not clobber it');
SELECT _assert_eq((SELECT serial_number::text FROM public.sales WHERE nft_id='ad5'), '3',
  'COALESCE keeps the surviving twin''s existing serial — incoming does not clobber it');

SELECT '✓ allday_sales_cross_source_dedup invariants pass' AS result;
ROLLBACK;

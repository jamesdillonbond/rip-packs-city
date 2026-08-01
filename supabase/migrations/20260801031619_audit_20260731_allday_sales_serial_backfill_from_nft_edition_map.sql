-- Applied to prod 2026-07-31 PT via MCP; filed here for the on-disk revert path.
--
-- Recover serial_number on AllDay onchain sales written with a NULL serial.
-- The allday-sales-indexer resolved serials ONLY from wallet_moments_cache plus
-- a Cadence borrow fallback capped at 12/run that fires only when the EDITION is
-- unresolved. For these NFTs wmc held no row at all, and the borrow resolved the
-- edition while returning no usable serialNumber, so the row was inserted with a
-- NULL serial. nft_edition_map -- the durable nftID->serial record already used
-- as a fallback by promote_unmapped_sales -- was never consulted on the
-- direct-insert path. 1,321 of 1,325 v2 rows had a positive serial here BEFORE
-- the sale row was written.
--
-- The writer fix ships in the same wave (app/api/allday-sales-indexer/route.ts);
-- this migration drains the rows that accumulated. Affects all three AllDay
-- onchain sources -- they share one insert path.
--
-- Revert:
--   UPDATE public.sales s SET serial_number = NULL
--     FROM public.audit_20260731_allday_serial_backfill a
--    WHERE s.id = a.sale_id AND s.serial_number = a.new_serial;
--   DROP TABLE public.audit_20260731_allday_serial_backfill;

CREATE TABLE IF NOT EXISTS public.audit_20260731_allday_serial_backfill (
  sale_id uuid PRIMARY KEY,
  nft_id varchar,
  source text,
  new_serial integer,
  backfilled_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_20260731_allday_serial_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260731_allday_serial_backfill FROM anon, authenticated;

WITH tgt AS (
  SELECT DISTINCT ON (s.id)
         s.id, s.nft_id, s.source, m.serial_number
    FROM public.sales s
    JOIN public.nft_edition_map m
      ON m.collection_id = s.collection_id
     AND m.nft_id = s.nft_id
   WHERE s.collection = 'nfl_all_day'
     AND s.source IN ('onchain_dapper_v1', 'onchain_dapper_v2', 'onchain')
     AND COALESCE(s.serial_number, 0) = 0
     AND m.serial_number > 0
   ORDER BY s.id, m.serial_number
), logged AS (
  INSERT INTO public.audit_20260731_allday_serial_backfill (sale_id, nft_id, source, new_serial)
  SELECT id, nft_id, source, serial_number FROM tgt
  ON CONFLICT (sale_id) DO NOTHING
  RETURNING sale_id
)
UPDATE public.sales s
   SET serial_number = t.serial_number
  FROM tgt t
 WHERE s.id = t.id;

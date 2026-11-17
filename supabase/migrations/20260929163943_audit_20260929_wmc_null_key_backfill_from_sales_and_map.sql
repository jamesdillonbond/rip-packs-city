-- One-shot corrective backfill: fill TS wallet_moments_cache.edition_key where it is NULL
-- from AUTHORITATIVE sources already in the DB (a recorded on-chain sale of the nft, or nft_edition_map).
-- Impossible-serial guarded (serial must not exceed base+parallels circulation). Fully audited for revert.
-- No new function is created here, so no anon-exec marker applies.
CREATE TABLE IF NOT EXISTS public.audit_20260929_wmc_null_key_backfill (
  id            uuid PRIMARY KEY,
  wallet_address text,
  moment_id     text,
  filled_key    text,
  serial_filled integer,
  source        text,
  filled_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260929_wmc_null_key_backfill ENABLE ROW LEVEL SECURITY;

WITH cand AS (
  SELECT w.id, w.wallet_address, w.moment_id,
    (SELECT es.external_id FROM public.sales s JOIN public.editions es ON es.id = s.edition_id
       WHERE s.nft_id = w.moment_id AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         AND s.edition_id IS NOT NULL ORDER BY s.sold_at DESC LIMIT 1) AS sales_key,
    (SELECT s.serial_number FROM public.sales s
       WHERE s.nft_id = w.moment_id AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         AND s.serial_number > 0 ORDER BY s.sold_at DESC LIMIT 1) AS sales_serial,
    (SELECT x.edition_external_id FROM public.nft_edition_map x
       WHERE x.nft_id = w.moment_id AND x.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         AND x.edition_external_id IS NOT NULL LIMIT 1) AS map_key,
    (SELECT x.serial_number FROM public.nft_edition_map x
       WHERE x.nft_id = w.moment_id AND x.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' LIMIT 1) AS map_serial
  FROM public.wallet_moments_cache w
  WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND w.edition_key IS NULL
),
resolved AS (
  SELECT id, wallet_address, moment_id,
         COALESCE(sales_key, map_key) AS proposed_key,
         COALESCE(sales_serial, map_serial) AS proposed_serial,
         CASE WHEN sales_key IS NOT NULL THEN 'sales' ELSE 'nft_edition_map' END AS source
  FROM cand
  WHERE COALESCE(sales_key, map_key) IS NOT NULL
),
ok AS (
  SELECT r.* FROM resolved r
  WHERE NOT (
    r.proposed_serial IS NOT NULL
    AND r.proposed_serial > (
      SELECT sum(t.circulation_count) FROM public.editions t
       WHERE t.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         AND (t.external_id = split_part(r.proposed_key,'::',1)
           OR t.external_id LIKE split_part(r.proposed_key,'::',1) || '::%'))
  )
),
logged AS (
  INSERT INTO public.audit_20260929_wmc_null_key_backfill
        (id, wallet_address, moment_id, filled_key, serial_filled, source)
  SELECT id, wallet_address, moment_id, proposed_key, proposed_serial, source FROM ok
  ON CONFLICT (id) DO NOTHING
)
UPDATE public.wallet_moments_cache w
   SET edition_key   = o.proposed_key,
       serial_number = COALESCE(w.serial_number, o.proposed_serial)
  FROM ok o
 WHERE w.id = o.id AND w.edition_key IS NULL;
-- 2026-09-25 (PT) — follow-through on 20260925095358: the 154 Top Shot editions
-- that just took their series from the chain have 2,268 wallet_moments_cache
-- rows still carrying series_number NULL (the 09-24 estate walk ran before the
-- editions had one). The per-wallet self-heal would fill them on each wallet's
-- next backfill; this fills them now, the same COALESCE-only way. The other
-- ~16k NULL wmc rows belong to edition_keys with no editions row at all and are
-- left alone (nothing to fill them from).
-- Revert: none needed (values are the editions'); UPDATE … SET series_number = NULL
-- WHERE ctid IN (…) is not recorded because the pre-image is NULL by predicate.

UPDATE public.wallet_moments_cache w
   SET series_number = e.series
  FROM public.editions e
 WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND w.series_number IS NULL
   AND e.collection_id = w.collection_id
   AND e.external_id = w.edition_key
   AND e.series IS NOT NULL;

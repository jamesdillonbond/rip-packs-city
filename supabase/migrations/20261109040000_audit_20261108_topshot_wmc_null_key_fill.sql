-- 2026-11-08 (Dame Time) — name the Top Shot wallet rows that sat without an
-- edition_key, from facts we already hold, ahead of the walker catching up.
--
-- Why: app/api/wallet-backfill skipped every CACHED row, keyed or not, so a row
-- whose metadata read failed once was never retried (fixed in e9ac06a). 2,749
-- key-less rows sat in two saved wallets (rrx69, wizwit); their Dame commons
-- were unsearchable in the challenge picker hours before the midnight PT close.
--
-- What: an nft_id -> edition mapping is immutable, so a key every source agrees
-- on is safe to write. Three sources: sales (edition_id), moments (edition_id),
-- topshot_ownership (edition_external_id). A row is filled ONLY when every
-- source that knows it names the SAME key; a disagreement is left for the chain
-- walk. Only NULL keys are touched (`AND w.edition_key IS NULL`).
--
-- Revert: UPDATE public.wallet_moments_cache w SET edition_key = NULL
--           FROM public.audit_20261108_wmc_null_key_fill a
--          WHERE w.id = a.wmc_id AND w.edition_key = a.filled_key;
--         DROP TABLE public.audit_20261108_wmc_null_key_fill;

CREATE TABLE IF NOT EXISTS public.audit_20261108_wmc_null_key_fill (
  wmc_id     uuid PRIMARY KEY,
  filled_key text NOT NULL,
  source     text NOT NULL,
  filled_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261108_wmc_null_key_fill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261108_wmc_null_key_fill FROM PUBLIC, anon, authenticated;

WITH src AS (
  SELECT w.id AS wmc_id, x.key
    FROM public.wallet_moments_cache w
    JOIN LATERAL (
      SELECT e.external_id AS key
        FROM public.sales s
        JOIN public.editions e ON e.id = s.edition_id AND e.collection_id = s.collection_id
       WHERE s.collection_id = w.collection_id AND s.nft_id = w.moment_id AND e.external_id IS NOT NULL
      UNION ALL
      SELECT e.external_id
        FROM public.moments m
        JOIN public.editions e ON e.id = m.edition_id
       WHERE m.collection_id = w.collection_id AND m.nft_id = w.moment_id AND e.external_id IS NOT NULL
      UNION ALL
      SELECT o.edition_external_id
        FROM public.topshot_ownership o
       WHERE o.nft_id::text = w.moment_id AND o.edition_external_id IS NOT NULL
    ) x ON true
   WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND w.edition_key IS NULL
),
agree AS (
  SELECT wmc_id, min(key) AS key FROM src GROUP BY wmc_id HAVING count(DISTINCT key) = 1
),
logged AS (
  INSERT INTO public.audit_20261108_wmc_null_key_fill (wmc_id, filled_key, source)
  SELECT wmc_id, key, 'sales|moments|topshot_ownership (unanimous)' FROM agree
  ON CONFLICT (wmc_id) DO NOTHING
  RETURNING wmc_id, filled_key
)
UPDATE public.wallet_moments_cache w
   SET edition_key = l.filled_key
  FROM logged l
 WHERE w.id = l.wmc_id
   AND w.edition_key IS NULL;

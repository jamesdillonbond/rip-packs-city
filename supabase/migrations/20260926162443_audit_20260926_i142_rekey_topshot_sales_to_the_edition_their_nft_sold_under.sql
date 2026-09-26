-- #142: re-key Top Shot sales whose serial cannot exist in their edition, where the
-- SAME nft_id has other sale rows under exactly ONE different edition that can hold
-- that serial (same serial, within that edition's base + parallels total).
-- Recipe from known-issues #142, re-derived 2026-09-26 ~9:35 AM PT: 1,389 impossible
-- rows, 85 with exactly one target edition, 82 after dropping same-tx pairs and
-- same-sale duplicates (sold_at +-120 s + price), 77 after EXCLUDING source='onchain'
-- (its serial may itself be the foreign one) and rows with no transaction_hash (a
-- same-tx pair cannot be ruled out). No row carries a moment_id, so edition_id is
-- the only column changed. Backup first; the UPDATE is keyed on (id, sold_at).
-- Revert: UPDATE public.sales s SET edition_id = b.old_edition_id
--           FROM public.audit_20260926_i142_sales_rekey b
--          WHERE s.id = b.sale_id AND s.sold_at = b.sold_at;
CREATE TABLE public.audit_20260926_i142_sales_rekey (
  sale_id uuid NOT NULL,
  sold_at timestamptz NOT NULL,
  nft_id text,
  serial_number integer,
  source text,
  old_edition_id uuid NOT NULL,
  new_edition_id uuid NOT NULL,
  rekeyed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_id, sold_at)
);
ALTER TABLE public.audit_20260926_i142_sales_rekey ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260926_i142_sales_rekey FROM PUBLIC, anon, authenticated;

INSERT INTO public.audit_20260926_i142_sales_rekey (sale_id, sold_at, nft_id, serial_number, source, old_edition_id, new_edition_id)
WITH ts AS (SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AS c),
ceil AS (
  SELECT e.id, greatest(coalesce(e.circulation_count, 0), coalesce(b.tot, 0)) AS ceiling
  FROM public.editions e
  LEFT JOIN (SELECT split_part(external_id, '::', 1) AS base, sum(circulation_count) AS tot
               FROM public.editions
              WHERE collection_id = (SELECT c FROM ts) AND circulation_count > 0
              GROUP BY 1) b ON b.base = split_part(e.external_id, '::', 1)
  WHERE e.collection_id = (SELECT c FROM ts)
),
imp AS (
  SELECT s.id, s.sold_at, s.nft_id, s.serial_number, s.edition_id, s.price_usd, s.transaction_hash, s.source
  FROM public.sales s JOIN ceil ON ceil.id = s.edition_id
  WHERE s.collection_id = (SELECT c FROM ts) AND s.serial_number IS NOT NULL
    AND ceil.ceiling > 0 AND s.serial_number > ceil.ceiling
),
pairs AS (
  SELECT i.id, i.sold_at, o.edition_id AS other_ed,
         (abs(extract(epoch FROM o.sold_at - i.sold_at)) <= 120 AND o.price_usd = i.price_usd) AS same_sale,
         (o.transaction_hash = i.transaction_hash) AS same_tx
  FROM imp i
  JOIN public.sales o ON o.collection_id = (SELECT c FROM ts) AND o.nft_id = i.nft_id
                     AND o.id <> i.id AND o.edition_id <> i.edition_id AND o.serial_number = i.serial_number
  JOIN ceil c2 ON c2.id = o.edition_id AND i.serial_number <= c2.ceiling
),
agg AS (
  SELECT i.id, i.sold_at, i.nft_id, i.serial_number, i.source, i.edition_id,
         count(DISTINCT p.other_ed) AS n_eds, bool_or(p.same_tx) AS any_same_tx,
         bool_and(p.same_sale) AS all_same_sale, min(p.other_ed::text)::uuid AS target
  FROM imp i JOIN pairs p ON p.id = i.id AND p.sold_at = i.sold_at
  GROUP BY 1, 2, 3, 4, 5, 6
)
SELECT id, sold_at, nft_id, serial_number, source, edition_id, target
FROM agg
WHERE n_eds = 1 AND NOT any_same_tx AND NOT all_same_sale
  AND source IS DISTINCT FROM 'onchain';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20260926_i142_sales_rekey;
  IF n < 60 OR n > 100 THEN
    RAISE EXCEPTION 'i142 re-key: % candidate rows, expected ~77 (re-derive before applying)', n;
  END IF;
END $$;

UPDATE public.sales s
   SET edition_id = b.new_edition_id
  FROM public.audit_20260926_i142_sales_rekey b
 WHERE s.id = b.sale_id AND s.sold_at = b.sold_at
   AND s.edition_id = b.old_edition_id;

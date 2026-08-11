-- Stage the AllDay pack-pull edition attribution backfill.
-- Source precedence: wmc (validated 100% agreement, n=2,991) then collection-scoped sales
-- (validated 100% agreement in 3-way overlap, n=1,503). Ambiguous moments are EXCLUDED.
-- Fill-only: never overwrites an existing edition_id.
CREATE TABLE IF NOT EXISTS public.audit_20260801_allday_pull_edition_backfill (
  moment_nft_id text PRIMARY KEY,
  edition_id    uuid NOT NULL,
  source        text NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_20260801_allday_pull_edition_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260801_allday_pull_edition_backfill FROM anon, authenticated;

WITH n AS (
  SELECT DISTINCT moment_nft_id FROM public.allday_pack_pull WHERE edition_id IS NULL
), cand AS (
  SELECT n.moment_nft_id, e.id AS edition_id, 1 AS pri, 'wmc'::text AS source
    FROM n
    JOIN public.wallet_moments_cache w
      ON w.moment_id = n.moment_nft_id
     AND w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND w.edition_key IS NOT NULL
    JOIN public.editions e
      ON e.external_id = w.edition_key
     AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  UNION
  SELECT n.moment_nft_id, s.edition_id, 2, 'sales'
    FROM n
    JOIN public.sales s
      ON s.nft_id = n.moment_nft_id
     AND s.edition_id IS NOT NULL
     AND s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
), unambiguous AS (
  SELECT moment_nft_id FROM cand GROUP BY moment_nft_id HAVING count(DISTINCT edition_id) = 1
), pick AS (
  SELECT DISTINCT ON (c.moment_nft_id) c.moment_nft_id, c.edition_id, c.source
    FROM cand c JOIN unambiguous u USING (moment_nft_id)
   ORDER BY c.moment_nft_id, c.pri
)
INSERT INTO public.audit_20260801_allday_pull_edition_backfill (moment_nft_id, edition_id, source)
SELECT moment_nft_id, edition_id, source FROM pick
ON CONFLICT (moment_nft_id) DO NOTHING;
-- One row per pack distribution stating WHAT the remaining-pull pool is derived from
-- and whether that basis is trustworthy. Deliberately cheap: no pack_rips scan.
-- REVERT: DROP VIEW IF EXISTS public.v_pack_remaining_basis;
CREATE OR REPLACE VIEW public.v_pack_remaining_basis AS
WITH pool AS (
  SELECT collection_id, dist_id,
         min(pool_source)                                    AS pool_source,
         count(*)                                            AS pool_rows,
         count(*) FILTER (WHERE drop_weight > 0)             AS live_rows,
         count(DISTINCT drop_weight) FILTER (WHERE drop_weight > 0) AS distinct_live_weights,
         round(COALESCE(sum(drop_weight) FILTER (WHERE drop_weight > 0), 0), 4) AS sum_drop_weight,
         max(last_refreshed_at)                              AS pool_refreshed_at
    FROM public.pack_drop_pool
   GROUP BY collection_id, dist_id
)
SELECT c.slug                                        AS collection,
       pd.dist_id,
       pd.title,
       pd.total_minted,
       pd.total_opened,
       pd.total_sealed,
       pd.depletion_pct,
       p.pool_source,
       p.pool_rows,
       p.live_rows,
       p.distinct_live_weights,
       p.sum_drop_weight,
       p.pool_refreshed_at,
       round(extract(epoch FROM (now() - p.pool_refreshed_at)) / 3600.0, 1) AS pool_age_hours,
       CASE
         WHEN p.pool_rows IS NULL                       THEN 'none'
         WHEN p.pool_source = 'gql_historical'          THEN 'original_supply_mislabelled'
         WHEN c.id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN 'original_supply'
         WHEN p.live_rows = 0                           THEN 'depleted'
         WHEN p.live_rows > 1 AND p.distinct_live_weights <= 1 THEN 'placeholder_uniform'
         ELSE 'publisher_remaining'
       END                                            AS remaining_basis,
       CASE
         WHEN p.pool_rows IS NULL                       THEN false
         WHEN p.pool_source = 'gql_historical'          THEN false
         WHEN c.id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN false
         WHEN p.live_rows = 0                           THEN false
         WHEN p.live_rows > 1 AND p.distinct_live_weights <= 1 THEN false
         WHEN p.sum_drop_weight < 0.5                   THEN false
         WHEN p.pool_refreshed_at < now() - interval '7 days' THEN false
         ELSE true
       END                                            AS remaining_trustworthy,
       CASE
         WHEN p.pool_rows IS NULL                       THEN 'no drop pool rows'
         WHEN p.pool_source = 'gql_historical'          THEN 'weights are original mint share, not remaining'
         WHEN c.id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN 'collection models original supply only'
         WHEN p.live_rows = 0                           THEN 'pool fully depleted'
         WHEN p.live_rows > 1 AND p.distinct_live_weights <= 1 THEN 'uniform placeholder pool'
         WHEN p.sum_drop_weight < 0.5                   THEN 'pool incomplete (sum drop_weight < 0.5)'
         WHEN p.pool_refreshed_at < now() - interval '7 days' THEN 'pool stale > 7d'
         ELSE 'ok'
       END                                            AS basis_note
  FROM public.pack_distributions pd
  JOIN public.collections c ON c.id = pd.collection_id
  LEFT JOIN pool p ON p.collection_id = pd.collection_id AND p.dist_id = pd.dist_id;

ALTER VIEW public.v_pack_remaining_basis SET (security_invoker = on);
REVOKE ALL ON public.v_pack_remaining_basis FROM anon, authenticated;
GRANT SELECT ON public.v_pack_remaining_basis TO service_role;
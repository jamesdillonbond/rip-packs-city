-- See v1 for the full rationale. v1 failed only on a column-type mismatch:
-- pack_price is numeric(10,2) in the existing view, so the CASE must be cast.
-- 2,764 AllDay/Golazos pack pages held a correct EV + full drop pool but rendered
-- "—" because `pack_price > 0` dropped rows whose price was UNKNOWN (the writers
-- coerce a missing Dapper price to literal 0). Genuine reward packs
-- (retail_price_usd = 0) and the 32 TS writer-bug rows (retail > 0) stay excluded.
-- Price-relative fields are forced NULL when the price is unknown, so no margin
-- is ever asserted against a price we do not have.
CREATE OR REPLACE VIEW public.pack_ev_latest AS
SELECT DISTINCT ON (pack_listing_id)
    pack_listing_id,
    collection_id,
    dist_id,
    pack_name,
    CASE WHEN pack_price > 0::numeric AND pack_price < 9999::numeric
         THEN pack_price ELSE NULL::numeric END::numeric(10,2) AS pack_price,
    CASE WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
         ELSE gross_ev END::numeric(10,2) AS gross_ev,
    CASE WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
         WHEN NOT (pack_price > 0::numeric AND pack_price < 9999::numeric) THEN NULL::numeric
         ELSE pack_ev END::numeric(10,2) AS pack_ev,
    CASE WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::boolean
         WHEN NOT (pack_price > 0::numeric AND pack_price < 9999::numeric) THEN NULL::boolean
         WHEN total_unopened IS NOT NULL AND total_unopened <= 0
           OR depletion_pct IS NOT NULL AND depletion_pct >= 100 THEN false
         ELSE is_positive_ev END AS is_positive_ev,
    CASE WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
         WHEN NOT (pack_price > 0::numeric AND pack_price < 9999::numeric) THEN NULL::numeric
         ELSE value_ratio END::numeric(12,4) AS value_ratio,
    CASE WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::smallint
         ELSE fmv_coverage_pct END AS fmv_coverage_pct,
    edition_count,
    total_unopened,
    CASE WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::smallint
         ELSE depletion_pct END AS depletion_pct,
    snapshotted_at,
    primary_price,
    secondary_ask,
    price_source,
    primary_available,
    secondary_available,
    CASE WHEN gross_ev = 0::numeric AND edition_count = 0 THEN NULL::numeric
         ELSE typical_ev END::numeric(10,2) AS typical_ev
  FROM pack_ev_history h
 WHERE pack_ev >= '-10000'::integer::numeric
   AND pack_ev <= 1000000::numeric
   AND pack_name !~~ 'Holding %'::text
   AND (
        (pack_price > 0::numeric AND pack_price < 9999::numeric)
        OR (
             (pack_price IS NULL OR pack_price <= 0::numeric OR pack_price >= 9999::numeric)
             AND NOT EXISTS (
               SELECT 1 FROM pack_distributions pd
                WHERE pd.dist_id = h.dist_id
                  AND pd.collection_id = h.collection_id
                  AND (pd.metadata->>'retail_price_usd') IS NOT NULL
             )
           )
       )
   AND NOT (collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
            AND EXISTS (SELECT 1 FROM pack_ask_state a
                         WHERE a.collection_slug = 'nba-top-shot'::text
                           AND a.dist_id = h.dist_id
                           AND a.is_listed IS TRUE
                           AND a.lowest_ask > 0::numeric
                           AND h.gross_ev > (3::numeric * a.lowest_ask)))
 ORDER BY pack_listing_id, snapshotted_at DESC;
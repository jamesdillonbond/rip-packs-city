-- v1 failed only on the missing parameter DEFAULT (the live signature is
-- p_limit integer DEFAULT 200). Rationale unchanged: 489 Top Shot pack pages
-- showed an Actual EV but "—" for Typical Pull, the weighted-median figure the
-- public pack-EV block leads with, because this backfill omitted `typical_ev`
-- from its INSERT column list. The two live writers already persist it; AllDay
-- and Pinnacle are at 100%. Body otherwise byte-identical.
CREATE OR REPLACE FUNCTION public.backfill_topshot_historical_pack_ev(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted int;
BEGIN
  WITH cand AS (
    SELECT d.dist_id, d.collection_id, d.title, d.metadata,
           CASE WHEN (d.metadata->>'retail_price_usd')::numeric >= 1000000
                THEN round((d.metadata->>'retail_price_usd')::numeric/100000000,2)
                ELSE round((d.metadata->>'retail_price_usd')::numeric,2) END AS pack_price,
           COALESCE(NULLIF((d.metadata->>'number_of_pack_slots'),'')::int, 1) AS slots,
           (SELECT a.lowest_ask FROM pack_ask_state a
             WHERE a.dist_id = d.dist_id AND a.collection_slug = 'nba-top-shot'
               AND a.is_listed IS TRUE AND a.lowest_ask > 0
             ORDER BY a.lowest_ask ASC LIMIT 1) AS sec_ask
    FROM pack_distributions d
    WHERE d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND d.metadata->>'uuid' IS NOT NULL
      AND (d.metadata->>'retail_price_usd') IS NOT NULL
      AND (d.metadata->>'retail_price_usd')::numeric > 0
      AND (SELECT count(DISTINCT p.drop_weight) FROM pack_drop_pool p
           WHERE p.collection_id = d.collection_id AND p.dist_id = d.dist_id
             AND p.drop_weight > 0) > 1
      AND NOT EXISTS (SELECT 1 FROM pack_ev_history h
                  WHERE h.collection_id = d.collection_id AND h.dist_id = d.dist_id
                    AND h.snapshotted_at > now() - interval '12 hours'
                    AND COALESCE(h.edition_count, 0) > 0)
    LIMIT GREATEST(p_limit, 1)
  ),
  computed AS (
    SELECT c.*, public.compute_pack_ev_per_edition_weighted(c.collection_id, c.dist_id, c.pack_price, c.slots) AS ev
    FROM cand c
  ),
  ins AS (
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
                                 gross_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct,
                                 edition_count, typical_ev, snapshotted_at)
    SELECT c.metadata->>'uuid', c.collection_id, c.dist_id, c.title, c.pack_price,
           (c.ev->>'gross_ev')::numeric, (c.ev->>'pack_ev')::numeric,
           COALESCE((c.ev->>'is_positive_ev')::boolean, false),
           (c.ev->>'value_ratio')::numeric, (c.ev->>'fmv_coverage_pct')::smallint,
           (c.ev->>'edition_count')::smallint,
           (c.ev->>'typical_pull_ev')::numeric,
           now()
    FROM computed c
    WHERE (c.ev->>'ok')::boolean = true
      AND c.sec_ask IS NOT NULL
      AND (c.ev->>'gross_ev')::numeric <= 3 * c.sec_ask
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.backfill_topshot_historical_pack_ev(integer) FROM PUBLIC, anon, authenticated;
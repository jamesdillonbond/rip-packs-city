-- Tighten the historical pack-EV guard (jobid 43): only emit EV when the remaining
-- pool has a REAL VARIED distribution of remaining moments (count(distinct drop_weight)
-- > 1), not a uniform/degenerate placeholder (packEditionsV3 returns identical weights
-- for depleted packs -> fabricated EV). Combined with the existing secondary-ask guard
-- (EV <= 3x live ask). Excludes the ~165 degenerate pools at the source, per Trevor
-- 2026-07-07 ("tighten survivor-bias detection"). Applied live via MCP (20260707064030).
-- Data-layer honesty; Fix B still decides display suppression (>=90% depleted etc.).
-- Revert: restore 20260707040750 (drop the `> 1 distinct drop_weight` clause).
CREATE OR REPLACE FUNCTION public.backfill_topshot_historical_pack_ev(p_limit integer DEFAULT 40)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '280s'
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
                                 edition_count, snapshotted_at)
    SELECT c.metadata->>'uuid', c.collection_id, c.dist_id, c.title, c.pack_price,
           (c.ev->>'gross_ev')::numeric, (c.ev->>'pack_ev')::numeric,
           COALESCE((c.ev->>'is_positive_ev')::boolean, false),
           (c.ev->>'value_ratio')::numeric, (c.ev->>'fmv_coverage_pct')::smallint,
           (c.ev->>'edition_count')::smallint, now()
    FROM computed c
    WHERE (c.ev->>'ok')::boolean = true
      AND c.sec_ask IS NOT NULL
      AND (c.ev->>'gross_ev')::numeric <= 3 * c.sec_ask
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END $function$;

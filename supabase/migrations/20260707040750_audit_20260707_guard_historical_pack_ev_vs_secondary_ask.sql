-- Guard the historical pack-EV backfill (jobid 43) against emitting fabricated /
-- survivor-biased EV. Per Trevor 2026-07-07: pack EV must reflect only the moments
-- still remaining in packs, compared to the SECONDARY low ask (primary price ignored).
-- The backfill's pool source (packEditionsV3) returns a uniform/chase-biased placeholder
-- for depleted packs, so its EV is unreliable there. Only emit an EV row when a live
-- secondary ask exists AND the computed gross EV is within 3x of it (Fix B's exact
-- survivor-bias criterion). Everything else -> no EV (honest empty state).
-- Applied live via MCP 2026-07-07 (version 20260707040750); reconciled into repo for reproducibility.
-- Revert: CREATE OR REPLACE without the `sec_ask`/`AND ... <= 3*c.sec_ask` guard.
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
      AND EXISTS (SELECT 1 FROM pack_drop_pool p
                  WHERE p.collection_id = d.collection_id AND p.dist_id = d.dist_id AND p.drop_weight > 0)
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

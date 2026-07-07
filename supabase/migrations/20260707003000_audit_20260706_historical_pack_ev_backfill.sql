-- Historical pack Contents + EV backfill (companion to the edge-fn mode=pool fix).
--
-- Context: 1,385 of 2,002 Top Shot pack distributions (69%) rendered empty
-- Contents + Pack EV because pack_drop_pool only covered Dapper's active pack
-- aggregation. The historical-pool backfill (backfill-topshot-pack-supply
-- mode=pool, pool_source='gql_historical') existed but had silently stalled at
-- 39/1385 dists since 2026-06-29 due to two writer bugs (drop_weight numeric(8,6)
-- overflow on raw mint counts >=100, and duplicate 4-col PKs when a set:play
-- repeats across pages) — both fixed in the edge fn on 2026-07-06.
--
-- The pool backfill writes COMPOSITION only. The active EV pipeline
-- (compute-topshot-pack-ev) never computes EV for these sold-out/historical dists
-- (its target view excludes them / they carry $0 pool_empty sentinels), so Pack EV
-- stays $0 even once pooled. This function computes + persists real EV
-- (pack_ev_history) for any TS dist that now has a pool but only a stale/sentinel
-- EV, using the canonical compute_pack_ev_per_edition_weighted math. The fresh row
-- then wins in mv_pack_ev_latest (DISTINCT ON pack_listing_id, snapshotted_at DESC)
-- and surfaces on pack_table_rows -> the pack detail page.
--
-- Idempotent: a dist is skipped only when it already has a REAL EV row
-- (edition_count>0) in the last 12h, so $0 sentinels get overridden but real rows
-- aren't churned. Reward packs (retail_price_usd=0) are intentionally excluded
-- (EV is suppressed for free packs).
--
-- Revert: DROP FUNCTION public.backfill_topshot_historical_pack_ev(int);
--         SELECT cron.unschedule('rpc-backfill-historical-pack-ev');
CREATE OR REPLACE FUNCTION public.backfill_topshot_historical_pack_ev(p_limit int DEFAULT 40)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '280s'
AS $$
DECLARE
  v_inserted int;
BEGIN
  WITH cand AS (
    SELECT d.dist_id, d.collection_id, d.title, d.metadata,
           CASE WHEN (d.metadata->>'retail_price_usd')::numeric >= 1000000
                THEN round((d.metadata->>'retail_price_usd')::numeric/100000000,2)
                ELSE round((d.metadata->>'retail_price_usd')::numeric,2) END AS pack_price,
           COALESCE(NULLIF((d.metadata->>'number_of_pack_slots'),'')::int, 1) AS slots
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
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END $$;

REVOKE ALL ON FUNCTION public.backfill_topshot_historical_pack_ev(int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_topshot_historical_pack_ev(int) TO service_role;

-- Durable EV drain: fills EV for pooled-but-no-EV dists as the pool backfill
-- progresses, and for future sold-out packs. Cheap no-op once caught up.
SELECT cron.schedule('rpc-backfill-historical-pack-ev', '3,13,23,33,43,53 * * * *',
  $cron$SELECT public.backfill_topshot_historical_pack_ev(30);$cron$);

-- Operational note (applied via cron.alter_job(16), not re-issued here):
-- the pool cron `rpc-backfill-pack-pool` (jobid 16) was repointed from the
-- silently-killed background path to the working synchronous one:
--   ...backfill-topshot-pack-supply?...&mode=pool&sync=1&limit=3&conc=2
-- (conc kept low so the shared topshot-proxy doesn't trip Cloudflare 1015).

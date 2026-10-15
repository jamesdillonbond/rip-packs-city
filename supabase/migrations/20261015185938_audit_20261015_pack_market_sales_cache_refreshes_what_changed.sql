-- 2026-10-15 (Claude Code cloud). refresh_pack_market_sales_cache: recompute what CHANGED first, then
-- only what is a day old — instead of the stalest 300 of 6,398 dists every 15 minutes regardless.
--
-- WHY. Measured 10-15: roster 6,398 dists (3,310 have never sold); ~30 dists sell in a day (71 in 48 h);
-- yet every dist was recomputed ~4.5x/day (300 per tick x 96 ticks), ~22k blocks per tick
-- (pg_stat_statements 22 h delta: 1.94M blocks read over 88 calls). And a new sale could still wait up
-- to ~5 h for its dist's turn in the rotation.
--
-- WHAT. Selection only; the stats (pack_market_sales_stats) and every write are unchanged.
--   1. DIRTY: dists whose newest secondary sale in pack_purchases (last 48 h, the same filters the stats
--      use: sale_price > 0, custom_id <> 'nba') is newer than the cache's recorded last_sale_at — i.e. a
--      sale the cache has not counted. Served by idx_pack_purchases_event_kind (~1.4k buffers). After one
--      recompute last_sale_at catches up, so a dist cannot stay dirty.
--   2. STALE: entries computed more than 20 h ago (rolls the 30/90-day windows forward daily; capacity
--      300 x 96 = 28,800/day >> 6,398), seeded -infinity rows first as before.
--   Dirty first, then stalest; same p_dists slice and soft deadline.
-- Effect: a new sale reaches the pack page within one tick (~15 min) instead of up to ~5 h; steady-state
-- work ~70 dists per tick instead of 300.
-- Known residual: a sale resolved to its dist LATE and older than the dist's newest recorded sale is
-- picked up by the daily STALE pass (<= ~20 h), as before it waited for its rotation turn.
-- extra gains dirty_refreshed / stale_refreshed / over_24h_remaining; stalest_remaining keeps its meaning.
--
-- anon-exec: intentional — same signature, ACL unchanged (service_role, postgres) (refresh_pack_market_sales_cache)
-- REVERT: re-apply the refresh_pack_market_sales_cache body of 20260924122325 verbatim.
CREATE OR REPLACE FUNCTION public.refresh_pack_market_sales_cache(p_dists integer DEFAULT 40, p_soft_deadline_s integer DEFAULT 45)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_ts_id    uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad_id    uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_seeded   int := 0;
  v_done     int := 0;
  v_dirty    int := 0;
  v_deadline boolean := false;
  r          record;
BEGIN
  -- 1. Roster: every known dist gets a row, stamped -infinity so it sorts first.
  INSERT INTO public.pack_market_sales_cache
    (collection_id, dist_id, n_sales, n_sales_30d, n_sales_90d, computed_at)
  SELECT pd.collection_id, pd.dist_id, 0, 0, 0, '-infinity'::timestamptz
  FROM public.pack_distributions pd
  WHERE pd.collection_id IN (v_ts_id, v_ad_id)
  ON CONFLICT (collection_id, dist_id) DO NOTHING;
  GET DIAGNOSTICS v_seeded = ROW_COUNT;

  -- 2. Dirty first (a sale the cache has not counted), then anything a day old.
  --    Stats come from pack_market_sales_stats(): on-chain sales + pre-feed studio history.
  FOR r IN
    WITH hot AS (
      SELECT p.collection_id, p.pack_dist_id AS dist_id, max(p.sealed_at) AS newest
      FROM public.pack_purchases p
      WHERE p.event_kind = 'secondary_sale'
        AND p.sealed_at > now() - interval '48 hours'
        AND p.pack_dist_id IS NOT NULL
        AND p.sale_price > 0
        AND p.custom_id IS DISTINCT FROM 'nba'
        AND p.collection_id IN (v_ts_id, v_ad_id)
      GROUP BY 1, 2
    ),
    cand AS (
      SELECT c.collection_id, c.dist_id, 0 AS pri, c.computed_at
      FROM public.pack_market_sales_cache c
      JOIN hot h ON h.collection_id = c.collection_id AND h.dist_id = c.dist_id
      WHERE h.newest > coalesce(c.last_sale_at, '-infinity'::timestamptz)
      UNION ALL
      SELECT c.collection_id, c.dist_id, 1 AS pri, c.computed_at
      FROM public.pack_market_sales_cache c
      WHERE c.collection_id IN (v_ts_id, v_ad_id)
        AND c.computed_at < now() - interval '20 hours'
    )
    SELECT collection_id, dist_id, min(pri) AS pri, min(computed_at) AS computed_at
    FROM cand
    GROUP BY collection_id, dist_id
    ORDER BY min(pri), min(computed_at), dist_id
    LIMIT p_dists
  LOOP
    IF extract(epoch FROM (clock_timestamp() - v_started)) > p_soft_deadline_s THEN
      v_deadline := true;
      EXIT;
    END IF;

    UPDATE public.pack_market_sales_cache c SET
      n_sales = s.n_sales, n_sales_30d = s.n_sales_30d, n_sales_90d = s.n_sales_90d,
      avg_price_90d = s.avg_price_90d, median_price_90d = s.median_price_90d,
      min_price_all = s.min_price_all, max_price_all = s.max_price_all,
      last_sale_price = s.last_sale_price, last_sale_at = s.last_sale_at,
      first_sale_at = s.first_sale_at,
      computed_at = now()
    FROM public.pack_market_sales_stats(r.collection_id, r.dist_id) s
    WHERE c.collection_id = r.collection_id AND c.dist_id = r.dist_id;

    v_done := v_done + 1;
    IF r.pri = 0 THEN v_dirty := v_dirty + 1; END IF;
  END LOOP;

  INSERT INTO public.pipeline_runs
    (pipeline, started_at, finished_at, rows_found, rows_written, ok, extra)
  VALUES ('pack-market-sales-cache-refresh', v_started, clock_timestamp(),
          v_done, v_done, true,
          jsonb_build_object(
            'dists_refreshed',   v_done,
            'dirty_refreshed',   v_dirty,
            'stale_refreshed',   v_done - v_dirty,
            'roster_seeded',     v_seeded,
            'slice_limit',       p_dists,
            'soft_deadline_s',   p_soft_deadline_s,
            'hit_soft_deadline', v_deadline,
            'source',            'pack_market_sales_stats',
            'selection',         'dirty-then-20h',
            'duration_ms',       (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
            'stalest_remaining', (SELECT count(*) FROM public.pack_market_sales_cache
                                   WHERE computed_at < now() - interval '6 hours'),
            'over_24h_remaining', (SELECT count(*) FROM public.pack_market_sales_cache
                                   WHERE computed_at < now() - interval '24 hours')
          ));

  RETURN jsonb_build_object('dists_refreshed', v_done, 'dirty_refreshed', v_dirty,
                            'roster_seeded', v_seeded, 'hit_soft_deadline', v_deadline);
END;
$function$;

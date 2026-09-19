-- audit_20260919_pack_market_cache_refresh_is_a_bounded_resumable_slice
--
-- ⛔ REPLACES the whole-table-pass body from `20260919180201`, which was
-- MEASURED AND REJECTED three minutes after it was applied (see that file: the
-- All Day arm alone was still on IO at 1 m 38 s and rolled back with 0 rows,
-- and a full pass would hold the multi-minute transaction R109 blames for
-- wallet_moments_cache never holding a visibility map).
--
-- ── THE SHAPE INSTEAD ─────────────────────────────────────────────────────────
-- Page a BOUNDED slice of the roster behind a staleness cursor, per CLAUDE.md's
-- standing rule for queue walks, with a SOFT DEADLINE so a tick that lands on
-- one of the four >=10,000-row dists commits what it finished instead of dying.
--
-- * ROSTER comes from `pack_distributions` (2,443 TS + 3,076 AD, indexed on
--   collection_id) - NOT `SELECT DISTINCT dist_id` over 592k history rows.
-- * Each dist is recomputed by its OWN aggregate, riding
--   `idx_ts_pack_sales_hist_dist` / `idx_allday_pack_sales_hist_dist`, so a tick
--   costs the sum of its slice, not the table.
-- * `computed_at ASC` is the cursor: self-levelling, resumable, cannot starve.
-- * A dist with no sales caches `n_sales = 0`, which is correct - the reader's
--   `WHERE n_sales > 0` then returns no row, matching live behaviour.
--
-- ⚠ The soft deadline is checked BETWEEN dists, never inside one, so the true
-- bound is "deadline + the cost of one dist". The worst single dist measured
-- 33.6 s, so leave that much headroom under the caller's budget.
--
-- 📏 MEASURED STEADY STATE, 2026-09-19: **408 ms/dist** (60 dists in 24,468 ms).
-- The first call read 1,021 ms/dist because it also seeded 5,520 roster rows.
-- A full cycle over 5,520 dists is therefore ~37 minutes of compute.
--
-- ⭐ WHICH IS WHY THE SCHEDULE IS DELIBERATELY SLOW (jobid 527, 60 dists every
-- 15 min => ~1 full cycle/day). A cache only pays if it refreshes LESS often
-- than the pages render: ~19,500 renders/day across 5,880 pack pages is ~3.3
-- renders/page/day, so refreshing more than ~3x/day would cost MORE IO than the
-- renders it replaces. At ~1 cycle/day this is ~11 GB/day against the ~39 GB/day
-- of live aggregation it removes - and every page becomes a single-row lookup
-- regardless. ⚠ That trade depends on the RENDER RATE; re-derive it before
-- speeding this job up.
--
-- REVERT: `SELECT cron.unschedule('rpc-pack-market-sales-cache-refresh');`
-- then `DROP FUNCTION public.refresh_pack_market_sales_cache(integer, integer);`

CREATE OR REPLACE FUNCTION public.refresh_pack_market_sales_cache(
  p_dists           integer DEFAULT 40,
  p_soft_deadline_s integer DEFAULT 45
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_ts_id    uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad_id    uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_seeded   int := 0;
  v_done     int := 0;
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

  -- 2. Walk the stalest slice.
  FOR r IN
    SELECT c.collection_id, c.dist_id
    FROM public.pack_market_sales_cache c
    WHERE c.collection_id IN (v_ts_id, v_ad_id)
    ORDER BY c.computed_at ASC, c.dist_id ASC
    LIMIT p_dists
  LOOP
    IF extract(epoch FROM (clock_timestamp() - v_started)) > p_soft_deadline_s THEN
      v_deadline := true;
      EXIT;
    END IF;

    IF r.collection_id = v_ts_id THEN
      UPDATE public.pack_market_sales_cache c SET
        n_sales = s.n_sales, n_sales_30d = s.n_sales_30d, n_sales_90d = s.n_sales_90d,
        avg_price_90d = s.avg_price_90d, median_price_90d = s.median_price_90d,
        min_price_all = s.min_price_all, max_price_all = s.max_price_all,
        last_sale_price = s.last_sale_price, last_sale_at = s.last_sale_at,
        computed_at = now()
      FROM (
        SELECT count(*) AS n_sales,
               count(*) FILTER (WHERE h.block_time > now() - interval '30 days') AS n_sales_30d,
               count(*) FILTER (WHERE h.block_time > now() - interval '90 days') AS n_sales_90d,
               round(avg(h.sale_price_usd) FILTER (WHERE h.block_time > now() - interval '90 days'), 2) AS avg_price_90d,
               round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY h.sale_price_usd::double precision)
                      FILTER (WHERE h.block_time > now() - interval '90 days'))::numeric, 2) AS median_price_90d,
               round(min(h.sale_price_usd), 2) AS min_price_all,
               round(max(h.sale_price_usd), 2) AS max_price_all,
               round((array_agg(h.sale_price_usd ORDER BY h.block_time DESC))[1], 2) AS last_sale_price,
               max(h.block_time) AS last_sale_at
        FROM public.topshot_pack_sales_history h
        WHERE h.dist_id = r.dist_id AND h.purchased AND h.sale_price_usd IS NOT NULL
      ) s
      WHERE c.collection_id = r.collection_id AND c.dist_id = r.dist_id;
    ELSE
      UPDATE public.pack_market_sales_cache c SET
        n_sales = s.n_sales, n_sales_30d = s.n_sales_30d, n_sales_90d = s.n_sales_90d,
        avg_price_90d = s.avg_price_90d, median_price_90d = s.median_price_90d,
        min_price_all = s.min_price_all, max_price_all = s.max_price_all,
        last_sale_price = s.last_sale_price, last_sale_at = s.last_sale_at,
        computed_at = now()
      FROM (
        SELECT count(*) AS n_sales,
               count(*) FILTER (WHERE h.block_time > now() - interval '30 days') AS n_sales_30d,
               count(*) FILTER (WHERE h.block_time > now() - interval '90 days') AS n_sales_90d,
               round(avg(h.sale_price_usd) FILTER (WHERE h.block_time > now() - interval '90 days'), 2) AS avg_price_90d,
               round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY h.sale_price_usd::double precision)
                      FILTER (WHERE h.block_time > now() - interval '90 days'))::numeric, 2) AS median_price_90d,
               round(min(h.sale_price_usd), 2) AS min_price_all,
               round(max(h.sale_price_usd), 2) AS max_price_all,
               round((array_agg(h.sale_price_usd ORDER BY h.block_time DESC))[1], 2) AS last_sale_price,
               max(h.block_time) AS last_sale_at
        FROM public.allday_pack_sales_history h
        WHERE h.dist_id = r.dist_id AND h.purchased AND h.sale_price_usd IS NOT NULL
      ) s
      WHERE c.collection_id = r.collection_id AND c.dist_id = r.dist_id;
    END IF;

    v_done := v_done + 1;
  END LOOP;

  INSERT INTO public.pipeline_runs
    (pipeline, started_at, finished_at, rows_found, rows_written, ok, extra)
  VALUES ('pack-market-sales-cache-refresh', v_started, clock_timestamp(),
          v_done, v_done, true,
          jsonb_build_object(
            'dists_refreshed',   v_done,
            'roster_seeded',     v_seeded,
            'slice_limit',       p_dists,
            'soft_deadline_s',   p_soft_deadline_s,
            'hit_soft_deadline', v_deadline,
            'duration_ms',       (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
            'stalest_remaining', (SELECT count(*) FROM public.pack_market_sales_cache
                                   WHERE computed_at < now() - interval '6 hours')
          ));

  RETURN jsonb_build_object('dists_refreshed', v_done, 'roster_seeded', v_seeded,
                            'hit_soft_deadline', v_deadline);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_pack_market_sales_cache(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_pack_market_sales_cache(integer, integer) TO postgres, service_role;
DROP FUNCTION IF EXISTS public.refresh_pack_market_sales_cache(uuid);

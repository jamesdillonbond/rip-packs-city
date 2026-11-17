-- audit_20260924_pack_market_board_reads_the_corrected_cache
--
-- Follow-on to 20260924122325 (pack market stats from on-chain sales). The
-- public boards /insights/topshot-pack-market and /insights/allday-pack-market
-- read v_topshot_pack_market / v_allday_pack_market, whose sales half is
-- mv_*_pack_sales_agg — a whole-table aggregate over the SAME studio subset
-- (DAPPER_MARKETPLACE only: 42% of Top Shot pack sales, listing-timestamped).
--
-- FIX: the two MVs now select from pack_market_sales_cache, which is computed
-- per dist by pack_market_sales_stats() (on-chain sales + pre-feed studio
-- history). One source of truth for the pack page and both boards, and each
-- MV refresh becomes a ~5k-row scan instead of a 550–590k-row double sort.
--   * pack_market_sales_cache gains first_sale_at (the boards show it); the
--     helper returns it, so its RETURNS TABLE changes → DROP + CREATE.
--   * roster: 204 Top Shot / 55 All Day dists existed only in the studio index
--     (not in pack_distributions); they are seeded into the cache here so the
--     boards keep them.
--   * Views are recreated VERBATIM from pg_get_viewdef (2026-09-24) with
--     security_invoker = on and their anon/authenticated SELECT grants; the
--     MVs keep their unique index names, so refresh_*_pack_sales_agg (pinned in
--     supabase/tests/mv_refresh_wrappers.sql) is untouched.
--   * cron rpc-pack-market-sales-cache-refresh: 60 → 300 dists per 15 min
--     (1,200 dists measured < 55 s in one call), so the ~5.9k roster cycles in
--     ~5 h instead of ~24 h.
--
-- anon-exec: NOT granted — pack_market_sales_stats is SECURITY INVOKER and
-- REVOKEd from PUBLIC/anon/authenticated; refresh_pack_market_sales_cache keeps
-- its signature (ACL preserved, anon/authenticated EXECUTE false live).
--
-- anon-exec: intentional — CREATE OR REPLACE of an existing signature keeps its live ACL (anon/authenticated EXECUTE false, service_role true, checked 2026-09-24) (refresh_pack_market_sales_cache)
--
-- REVERT: DROP both views + MVs, recreate the MVs from their old definitions
-- (20260924122325 header quotes the old source; pg_get_viewdef snapshot of the
-- 2026-09-23 MV bodies = GROUP BY dist_id over *_pack_sales_history WHERE
-- dist_id IS NOT NULL AND purchased AND sale_price_usd IS NOT NULL), recreate
-- the views, and cron.schedule('rpc-pack-market-sales-cache-refresh',
-- '7,22,37,52 * * * *', 'SELECT public.refresh_pack_market_sales_cache(60, 45);').

ALTER TABLE public.pack_market_sales_cache ADD COLUMN IF NOT EXISTS first_sale_at timestamptz;

DROP FUNCTION IF EXISTS public.pack_market_sales_stats(uuid, text);

CREATE FUNCTION public.pack_market_sales_stats(p_collection_id uuid, p_dist_id text)
 RETURNS TABLE(n_sales bigint, n_sales_30d bigint, n_sales_90d bigint, avg_price_90d numeric,
               median_price_90d numeric, min_price_all numeric, max_price_all numeric,
               last_sale_price numeric, last_sale_at timestamp with time zone,
               first_sale_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH chain AS (
    SELECT p.sale_price AS price, p.sealed_at AS at
      FROM public.pack_purchases p
     WHERE p.collection_id = p_collection_id
       AND p.pack_dist_id = p_dist_id
       AND p.event_kind = 'secondary_sale'
       AND p.sale_price > 0
  ), studio_pre AS (
    SELECT h.sale_price_usd AS price, h.block_time AS at
      FROM public.topshot_pack_sales_history h
     WHERE p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND h.dist_id = p_dist_id AND h.purchased AND h.sale_price_usd > 0
       AND h.block_time < '2026-04-10'::timestamptz
       AND NOT EXISTS (SELECT 1 FROM public.pack_purchases pp
                        WHERE pp.pack_nft_id = h.pack_nft_id
                          AND pp.listing_resource_id = h.listing_resource_id
                          AND pp.event_kind = 'secondary_sale')
    UNION ALL
    SELECT h.sale_price_usd, h.block_time
      FROM public.allday_pack_sales_history h
     WHERE p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
       AND h.dist_id = p_dist_id AND h.purchased AND h.sale_price_usd > 0
       AND h.block_time < '2026-04-24'::timestamptz
       AND NOT EXISTS (SELECT 1 FROM public.pack_purchases pp
                        WHERE pp.pack_nft_id = h.pack_nft_id
                          AND pp.listing_resource_id = h.listing_resource_id
                          AND pp.event_kind = 'secondary_sale')
  ), a AS (
    SELECT price, at FROM chain
    UNION ALL
    SELECT price, at FROM studio_pre
  )
  SELECT count(*),
         count(*) FILTER (WHERE a.at > now() - interval '30 days'),
         count(*) FILTER (WHERE a.at > now() - interval '90 days'),
         round(avg(a.price) FILTER (WHERE a.at > now() - interval '90 days'), 2),
         round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY a.price::double precision)
                FILTER (WHERE a.at > now() - interval '90 days'))::numeric, 2),
         round(min(a.price), 2),
         round(max(a.price), 2),
         round((array_agg(a.price ORDER BY a.at DESC))[1], 2),
         max(a.at),
         min(a.at)
    FROM a;
$function$;

COMMENT ON FUNCTION public.pack_market_sales_stats(uuid, text) IS
  'Pack market stats for one Top Shot / All Day dist: on-chain pack_purchases secondary sales (every marketplace, sale-timestamped) plus studio-index rows listed before the on-chain feed began. The studio index alone carries only DAPPER_MARKETPLACE sales (42% of Top Shot). Feeds pack_market_sales_cache → get_pack_market_row and mv_*_pack_sales_agg. 2026-09-24.';

REVOKE ALL ON FUNCTION public.pack_market_sales_stats(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pack_market_sales_stats(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_pack_market_sales_cache(p_dists integer DEFAULT 40, p_soft_deadline_s integer DEFAULT 45)
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

  -- 2. Walk the stalest slice. Stats come from pack_market_sales_stats():
  --    on-chain sales + pre-feed studio history (2026-09-24).
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
            'source',            'pack_market_sales_stats',
            'duration_ms',       (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
            'stalest_remaining', (SELECT count(*) FROM public.pack_market_sales_cache
                                   WHERE computed_at < now() - interval '6 hours')
          ));

  RETURN jsonb_build_object('dists_refreshed', v_done, 'roster_seeded', v_seeded,
                            'hit_soft_deadline', v_deadline);
END;
$function$;

-- Studio-only dists (not in pack_distributions) join the roster so the boards keep them.
INSERT INTO public.pack_market_sales_cache (collection_id, dist_id, n_sales, n_sales_30d, n_sales_90d, computed_at)
SELECT DISTINCT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, h.dist_id, 0, 0, 0, '-infinity'::timestamptz
  FROM public.mv_topshot_pack_sales_agg h
ON CONFLICT (collection_id, dist_id) DO NOTHING;
INSERT INTO public.pack_market_sales_cache (collection_id, dist_id, n_sales, n_sales_30d, n_sales_90d, computed_at)
SELECT DISTINCT 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, h.dist_id, 0, 0, 0, '-infinity'::timestamptz
  FROM public.mv_allday_pack_sales_agg h
ON CONFLICT (collection_id, dist_id) DO NOTHING;

-- Every row must carry first_sale_at before the MVs read the cache: recompute all
-- rows now is too long for one migration, so re-queue them to the front instead;
-- the cron below (300 / 15 min) and a manual drain fill them.
UPDATE public.pack_market_sales_cache SET computed_at = '1970-01-01'::timestamptz
 WHERE computed_at > '-infinity'::timestamptz AND n_sales > 0;

DROP VIEW public.v_topshot_pack_market;
DROP VIEW public.v_allday_pack_market;
DROP MATERIALIZED VIEW public.mv_topshot_pack_sales_agg;
DROP MATERIALIZED VIEW public.mv_allday_pack_sales_agg;

CREATE MATERIALIZED VIEW public.mv_topshot_pack_sales_agg AS
 SELECT c.dist_id, c.n_sales, c.n_sales_30d, c.n_sales_90d, c.avg_price_90d, c.median_price_90d,
        c.min_price_all, c.max_price_all, c.last_sale_price, c.last_sale_at, c.first_sale_at
   FROM public.pack_market_sales_cache c
  WHERE c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND c.n_sales > 0;
CREATE UNIQUE INDEX mv_topshot_pack_sales_agg_dist ON public.mv_topshot_pack_sales_agg USING btree (dist_id);

CREATE MATERIALIZED VIEW public.mv_allday_pack_sales_agg AS
 SELECT c.dist_id, c.n_sales, c.n_sales_30d, c.n_sales_90d, c.avg_price_90d, c.median_price_90d,
        c.min_price_all, c.max_price_all, c.last_sale_price, c.last_sale_at, c.first_sale_at
   FROM public.pack_market_sales_cache c
  WHERE c.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND c.n_sales > 0;
CREATE UNIQUE INDEX mv_allday_pack_sales_agg_dist ON public.mv_allday_pack_sales_agg USING btree (dist_id);

REVOKE ALL ON public.mv_topshot_pack_sales_agg FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.mv_allday_pack_sales_agg FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_topshot_pack_sales_agg TO service_role;
GRANT ALL ON public.mv_allday_pack_sales_agg TO service_role;

CREATE VIEW public.v_topshot_pack_market WITH (security_invoker = on) AS
 WITH s AS (
         SELECT mv_topshot_pack_sales_agg.dist_id,
            mv_topshot_pack_sales_agg.n_sales,
            mv_topshot_pack_sales_agg.n_sales_30d,
            mv_topshot_pack_sales_agg.n_sales_90d,
            mv_topshot_pack_sales_agg.avg_price_90d,
            mv_topshot_pack_sales_agg.median_price_90d,
            mv_topshot_pack_sales_agg.min_price_all,
            mv_topshot_pack_sales_agg.max_price_all,
            mv_topshot_pack_sales_agg.last_sale_price,
            mv_topshot_pack_sales_agg.last_sale_at,
            mv_topshot_pack_sales_agg.first_sale_at
           FROM mv_topshot_pack_sales_agg
        ), ev AS (
         SELECT DISTINCT ON (mv_pack_ev_latest.dist_id) mv_pack_ev_latest.dist_id,
            mv_pack_ev_latest.pack_price
           FROM mv_pack_ev_latest
          WHERE ((mv_pack_ev_latest.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AND (mv_pack_ev_latest.pack_price < (9999)::numeric))
          ORDER BY mv_pack_ev_latest.dist_id, mv_pack_ev_latest.snapshotted_at DESC
        )
 SELECT s.dist_id,
    COALESCE(d.title, ( SELECT (d2.metadata ->> 'name'::text)
           FROM pack_distributions d2
          WHERE ((d2.dist_id = d.dist_id) AND (d2.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)))) AS title,
    sup.total_minted AS drop_size,
    sup.depletion_pct,
    ev.pack_price AS retail_price,
    s.n_sales,
    s.n_sales_30d,
    s.n_sales_90d,
    s.last_sale_price,
    s.last_sale_at,
    s.avg_price_90d,
    s.median_price_90d,
    s.min_price_all,
    s.max_price_all,
    s.first_sale_at,
        CASE
            WHEN ((ev.pack_price > (0)::numeric) AND (s.median_price_90d IS NOT NULL)) THEN round((s.median_price_90d / ev.pack_price), 2)
            ELSE NULL::numeric
        END AS secondary_vs_retail_ratio
   FROM (((s
     LEFT JOIN pack_distributions d ON (((d.dist_id = s.dist_id) AND (d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid))))
     LEFT JOIN ev ON ((ev.dist_id = s.dist_id)))
     LEFT JOIN topshot_pack_supply sup ON ((sup.dist_id = s.dist_id)));

CREATE VIEW public.v_allday_pack_market WITH (security_invoker = on) AS
 WITH s AS (
         SELECT mv_allday_pack_sales_agg.dist_id,
            mv_allday_pack_sales_agg.n_sales,
            mv_allday_pack_sales_agg.n_sales_30d,
            mv_allday_pack_sales_agg.n_sales_90d,
            mv_allday_pack_sales_agg.avg_price_90d,
            mv_allday_pack_sales_agg.median_price_90d,
            mv_allday_pack_sales_agg.min_price_all,
            mv_allday_pack_sales_agg.max_price_all,
            mv_allday_pack_sales_agg.last_sale_price,
            mv_allday_pack_sales_agg.last_sale_at,
            mv_allday_pack_sales_agg.first_sale_at
           FROM mv_allday_pack_sales_agg
        )
 SELECT sup.dist_id,
    sup.title,
    sup.total_minted AS drop_size,
    sup.pack_price AS retail_price,
    sup.opened_count,
        CASE
            WHEN ((sup.total_minted > 0) AND (sup.opened_count IS NOT NULL)) THEN round(LEAST(100.0, ((100.0 * (sup.opened_count)::numeric) / (sup.total_minted)::numeric)), 1)
            ELSE NULL::numeric
        END AS opened_pct_of_minted,
    s.n_sales,
    s.n_sales_30d,
    s.n_sales_90d,
    s.last_sale_price,
    s.last_sale_at,
    s.avg_price_90d,
    s.median_price_90d,
    s.min_price_all,
    s.max_price_all,
    s.first_sale_at,
        CASE
            WHEN ((sup.pack_price > (0)::numeric) AND (s.median_price_90d IS NOT NULL)) THEN round((s.median_price_90d / sup.pack_price), 2)
            ELSE NULL::numeric
        END AS secondary_vs_retail_ratio
   FROM (allday_pack_supply sup
     JOIN s ON ((s.dist_id = sup.dist_id)));

GRANT SELECT ON public.v_topshot_pack_market TO anon, authenticated;
GRANT SELECT ON public.v_allday_pack_market TO anon, authenticated;
GRANT ALL ON public.v_topshot_pack_market TO service_role;
GRANT ALL ON public.v_allday_pack_market TO service_role;

SELECT cron.schedule('rpc-pack-market-sales-cache-refresh', '7,22,37,52 * * * *',
                     'SELECT public.refresh_pack_market_sales_cache(300, 45);');

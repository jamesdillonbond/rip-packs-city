-- audit_20261110_panini_sale_feed_status_refreshes_hourly
--
-- WHY (Claude Code cloud, 2026-11-10 ~2:25 PM PT, autonomous pass; pgss 12:05 -> 2:05 PM PT): refresh_panini_sale_feed_status
-- (pg_cron 714, '14,44 * * * *') index-only-scans every panini_card_serials row (5.2M, up from 2.48M when this
-- snapshot was introduced 10-09) for five counters: 16 s warm / 630k buffers in EXPLAIN, 22-30 s average per run
-- (pipeline_runs, 11-07 -> 11-10), up to 102 s, ~54k blocks read per run. Its only reader is the public
-- /api/public/insights/panini-squeeze `sale_price_feed` disclosure, whose time-sensitive field (feed_ok = a sale in the
-- last 3 days) does not move in an hour.
--
-- WHAT. Job 714 runs hourly at :14. The view's snapshot window grows 75 -> 135 min so the same tolerance holds: one
-- missed tick (60 + 60 min + a run of up to ~2 min) still serves the snapshot, never the slow live fallback. The view is
-- otherwise byte-for-byte the live definition (pg_get_viewdef at 2:24 PM PT), recreated WITH (security_invoker = on)
-- because CREATE OR REPLACE VIEW resets reloptions. pipeline_cadence_watchlist allows 95 min silence / 185 min without
-- success, both above the new period. Half the refresh cost: ~24 runs/day instead of 48.
--
-- REVERT: SELECT cron.alter_job(714, schedule := '14,44 * * * *'); and recreate the view with '01:15:00'.

CREATE OR REPLACE VIEW public.panini_sale_feed_status WITH (security_invoker = on) AS
 WITH snap AS (
         SELECT panini_sale_feed_status_snapshot.newest_sale_at,
            panini_sale_feed_status_snapshot.total_serials,
            panini_sale_feed_status_snapshot.priced_serials,
            panini_sale_feed_status_snapshot.preserved_fossils,
            panini_sale_feed_status_snapshot.sales_recorded_7d,
            panini_sale_feed_status_snapshot.computed_at
           FROM panini_sale_feed_status_snapshot
          WHERE panini_sale_feed_status_snapshot.computed_at > (now() - '02:15:00'::interval)
        ), live AS (
         SELECT l.newest_sale_at,
            l.total_serials,
            l.priced_serials,
            l.preserved_fossils,
            l.sales_recorded_7d,
            l.computed_at
           FROM ( SELECT max(panini_card_serials.last_sale_at) AS newest_sale_at,
                    count(*) AS total_serials,
                    count(*) FILTER (WHERE panini_card_serials.last_sale_usd IS NOT NULL) AS priced_serials,
                    count(*) FILTER (WHERE panini_card_serials.last_sale_preserved_at IS NOT NULL) AS preserved_fossils,
                    count(*) FILTER (WHERE panini_card_serials.last_sale_at > (now() - '7 days'::interval)) AS sales_recorded_7d,
                    now() AS computed_at
                   FROM panini_card_serials) l
          WHERE NOT (EXISTS ( SELECT 1
                   FROM snap))
        ), supply AS (
         SELECT snap.newest_sale_at,
            snap.total_serials,
            snap.priced_serials,
            snap.preserved_fossils,
            snap.sales_recorded_7d,
            snap.computed_at,
            'snapshot'::text AS status_source
           FROM snap
        UNION ALL
         SELECT live.newest_sale_at,
            live.total_serials,
            live.priced_serials,
            live.preserved_fossils,
            live.sales_recorded_7d,
            live.computed_at,
            'live'::text AS status_source
           FROM live
        )
 SELECT newest_sale_at::date AS last_supplied_on,
    CURRENT_DATE - newest_sale_at::date AS days_since_last_supplied,
    total_serials,
    priced_serials,
    preserved_fossils,
    round(100.0 * priced_serials::numeric / NULLIF(total_serials, 0)::numeric, 2) AS pct_serials_priced,
    newest_sale_at > (now() - '3 days'::interval) AS feed_ok,
    newest_sale_at,
    sales_recorded_7d,
    'nftSalesData (SALES HISTORY tab), since 2026-08-08'::text AS feed_source,
    status_source,
    computed_at AS status_computed_at
   FROM supply;

SELECT cron.alter_job(714, schedule := '14 * * * *');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'panini_sale_feed_status' AND reloptions @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'panini_sale_feed_status lost security_invoker';
  END IF;
  IF (SELECT schedule FROM cron.job WHERE jobid = 714) <> '14 * * * *' THEN
    RAISE EXCEPTION 'job 714 schedule not moved';
  END IF;
  IF has_table_privilege('anon', 'public.panini_sale_feed_status', 'SELECT') THEN
    RAISE EXCEPTION 'panini_sale_feed_status is anon-readable';
  END IF;
END $$;

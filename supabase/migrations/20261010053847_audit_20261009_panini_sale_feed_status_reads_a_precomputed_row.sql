-- audit_20261009_panini_sale_feed_status_reads_a_precomputed_row
--
-- 2026-10-09 ~10:45 PM PT (Claude Code cloud; Trevor: "Do it").
--
-- MEASURED: the trust-health arm read public_board_slow_count = 1 again, and the slow board is
-- panini_sale_feed_status (4,317 ms in the 5:28 PM PT sweep; 4,768 ms by EXPLAIN ANALYZE at ~10:10 PM PT:
-- Parallel Index Only Scan on idx_panini_serials_feed_status, 2 x 1,239,071 rows, 249,168 hit +
-- 20,737 read buffers). The 10-02 covering index took it from 7.7 s to 0.72 s when panini_card_serials
-- held 1.07 M rows. It now holds 2.48 M, and the view is five aggregates over EVERY row (count(*) is
-- one of them), so no index can bound it: the cost grows with the table.
--
-- CHANGE: the aggregates are computed by refresh_panini_sale_feed_status() into a one-row table
-- (panini_sale_feed_status_snapshot) every 30 min (pg_cron rpc-panini-sale-feed-status-refresh,
-- '14,44 * * * *' -- the two lightest even-spaced minute pair in a 24 h cron_job_run_details read).
-- The view keeps its exact columns, order and types (the route and the liveness sweep are unchanged)
-- and APPENDS two: status_source ('snapshot' | 'live') and status_computed_at.
--
-- HONESTY: a stale or missing snapshot is never served. The view reads the snapshot only while
-- computed_at is within 75 min (two missed ticks plus slack); otherwise it computes LIVE exactly as
-- before (slow but true), and status_source says which. A dead refresher therefore shows up as the
-- same public_board_slow_count breach this migration clears, not as a frozen status.
-- Values that depend on now() (days_since_last_supplied, feed_ok) are still computed at READ time
-- from the stored newest_sale_at. sales_recorded_7d is as of status_computed_at (<= 75 min old).
--
-- The refresher has no exception handler on purpose: a failed or killed run raises, pg_cron records
-- it, nothing is written (the old row stays and ages into the live fallback), and no ok=true is logged.
--
-- anon-exec: revoked (refresh_panini_sale_feed_status) -- new SECDEF writer; REVOKE FROM PUBLIC, anon, authenticated below, GRANT service_role.
--
-- REVERT (restores the 10-02 view verbatim, then drops the new objects):
--   CREATE OR REPLACE VIEW is not enough (it cannot drop the two appended columns), so:
--   SELECT cron.unschedule('rpc-panini-sale-feed-status-refresh');
--   DROP VIEW public.panini_sale_feed_status;
--   CREATE VIEW public.panini_sale_feed_status WITH (security_invoker = on) AS
--     WITH supply AS (SELECT max(last_sale_at) AS newest_sale_at, count(*) AS total_serials,
--       count(*) FILTER (WHERE last_sale_usd IS NOT NULL) AS priced_serials,
--       count(*) FILTER (WHERE last_sale_preserved_at IS NOT NULL) AS preserved_fossils,
--       count(*) FILTER (WHERE last_sale_at > now() - interval '7 days') AS sales_recorded_7d
--       FROM public.panini_card_serials)
--     SELECT newest_sale_at::date AS last_supplied_on, CURRENT_DATE - newest_sale_at::date AS days_since_last_supplied,
--       total_serials, priced_serials, preserved_fossils,
--       round(100.0 * priced_serials::numeric / NULLIF(total_serials, 0)::numeric, 2) AS pct_serials_priced,
--       newest_sale_at > now() - interval '3 days' AS feed_ok, newest_sale_at, sales_recorded_7d,
--       'nftSalesData (SALES HISTORY tab), since 2026-08-08'::text AS feed_source FROM supply;
--   (then re-apply the view's previous grants: compare with has_table_privilege before/after)
--   DROP FUNCTION public.refresh_panini_sale_feed_status();
--   DROP TABLE public.panini_sale_feed_status_snapshot;

CREATE TABLE IF NOT EXISTS public.panini_sale_feed_status_snapshot (
  id                 boolean     PRIMARY KEY DEFAULT true CHECK (id),
  newest_sale_at     timestamptz,
  total_serials      bigint      NOT NULL,
  priced_serials     bigint      NOT NULL,
  preserved_fossils  bigint      NOT NULL,
  sales_recorded_7d  bigint      NOT NULL,
  computed_at        timestamptz NOT NULL,
  duration_ms        integer     NOT NULL
);
ALTER TABLE public.panini_sale_feed_status_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_sale_feed_status_snapshot FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.panini_sale_feed_status_snapshot IS
  'One row: the five panini_card_serials aggregates behind panini_sale_feed_status, written by refresh_panini_sale_feed_status() every 30 min. The view ignores it once older than 75 min.';

CREATE OR REPLACE FUNCTION public.refresh_panini_sale_feed_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_row public.panini_sale_feed_status_snapshot%ROWTYPE;
BEGIN
  SELECT true,
         max(s.last_sale_at),
         count(*),
         count(*) FILTER (WHERE s.last_sale_usd IS NOT NULL),
         count(*) FILTER (WHERE s.last_sale_preserved_at IS NOT NULL),
         count(*) FILTER (WHERE s.last_sale_at > now() - interval '7 days'),
         clock_timestamp(),
         0
    INTO v_row
    FROM public.panini_card_serials s;

  v_row.duration_ms := round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int;

  INSERT INTO public.panini_sale_feed_status_snapshot AS t
    (id, newest_sale_at, total_serials, priced_serials, preserved_fossils, sales_recorded_7d, computed_at, duration_ms)
  VALUES (true, v_row.newest_sale_at, v_row.total_serials, v_row.priced_serials, v_row.preserved_fossils,
          v_row.sales_recorded_7d, v_row.computed_at, v_row.duration_ms)
  ON CONFLICT (id) DO UPDATE
    SET newest_sale_at = EXCLUDED.newest_sale_at, total_serials = EXCLUDED.total_serials,
        priced_serials = EXCLUDED.priced_serials, preserved_fossils = EXCLUDED.preserved_fossils,
        sales_recorded_7d = EXCLUDED.sales_recorded_7d, computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  PERFORM public.log_pipeline_run('panini-sale-feed-status-refresh', v_started,
    v_row.total_serials::int, 1, 0, true, NULL, 'panini_blockchain', NULL, NULL,
    jsonb_build_object('newest_sale_at', v_row.newest_sale_at, 'priced_serials', v_row.priced_serials,
                       'sales_recorded_7d', v_row.sales_recorded_7d, 'duration_ms', v_row.duration_ms));

  RETURN jsonb_build_object('ok', true, 'total_serials', v_row.total_serials,
                            'newest_sale_at', v_row.newest_sale_at, 'duration_ms', v_row.duration_ms);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_sale_feed_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_sale_feed_status() TO postgres, service_role;

-- Same 10 columns, same order and types; two appended. WITH (security_invoker = on) restated because
-- CREATE OR REPLACE VIEW resets reloptions.
CREATE OR REPLACE VIEW public.panini_sale_feed_status WITH (security_invoker = on) AS
WITH snap AS (
  SELECT newest_sale_at, total_serials, priced_serials, preserved_fossils, sales_recorded_7d, computed_at
    FROM public.panini_sale_feed_status_snapshot
   WHERE computed_at > now() - interval '75 minutes'
), live AS (
  SELECT l.*
    FROM (SELECT max(panini_card_serials.last_sale_at) AS newest_sale_at,
                 count(*) AS total_serials,
                 count(*) FILTER (WHERE panini_card_serials.last_sale_usd IS NOT NULL) AS priced_serials,
                 count(*) FILTER (WHERE panini_card_serials.last_sale_preserved_at IS NOT NULL) AS preserved_fossils,
                 count(*) FILTER (WHERE panini_card_serials.last_sale_at > now() - interval '7 days') AS sales_recorded_7d,
                 now() AS computed_at
            FROM public.panini_card_serials) l
   WHERE NOT EXISTS (SELECT 1 FROM snap)
), supply AS (
  SELECT snap.*, 'snapshot'::text AS status_source FROM snap
  UNION ALL
  SELECT live.*, 'live'::text AS status_source FROM live
)
SELECT (newest_sale_at)::date AS last_supplied_on,
       (CURRENT_DATE - (newest_sale_at)::date) AS days_since_last_supplied,
       total_serials,
       priced_serials,
       preserved_fossils,
       round(((100.0 * (priced_serials)::numeric) / (NULLIF(total_serials, 0))::numeric), 2) AS pct_serials_priced,
       (newest_sale_at > (now() - '3 days'::interval)) AS feed_ok,
       newest_sale_at,
       sales_recorded_7d,
       'nftSalesData (SALES HISTORY tab), since 2026-08-08'::text AS feed_source,
       status_source,
       computed_at AS status_computed_at
  FROM supply;

SELECT public.refresh_panini_sale_feed_status();

SELECT cron.schedule('rpc-panini-sale-feed-status-refresh', '14,44 * * * *',
                     'SELECT public.refresh_panini_sale_feed_status();');

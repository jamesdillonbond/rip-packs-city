-- audit_20260802_perfect_mint_premiums_board_materialize
--   + audit_20260802_perfect_mint_premiums_mv_revoke_anon   (20260802030135)
--   + audit_20260802_schedule_perfect_mint_premiums_refresh (20260802030142)
-- Applied to prod 2026-08-02 03:00-03:01 UTC / 2026-08-01 20:00 PT via Supabase MCP.
-- This file is the idempotent repo record for all three.
--
-- WHY: measured live with EXPLAIN (ANALYZE, BUFFERS):
--   Execution Time 16,992 ms, 178 rows, 667,457 shared hit + 43,905 read.
-- That is >half the 30s service_role statement budget on an IOPS-bound Micro.
-- The public consumer (/api/public/insights/serial-premiums via
-- lib/serial-premiums-board.ts) is FAIL-SOFT, so a contention spike does not
-- error -- it renders an EMPTY board. That is the silent-lie failure that hit
-- candy_holder_board on 2026-08-01 (82s -> "Holders 0" with nothing in Sentry).
--
-- The cost is intrinsic, not a missing index: the ed_med CTE runs
-- percentile_cont over 432,428 rows of the 180d Top Shot sales window (6,532 ms)
-- and the `perfect` CTE scans the 90d window (10,204 ms). No index makes a
-- 432k-row percentile group-aggregate cheap. Output is 178 rows.
--
-- Follows audit_20260801_market_index_daily_materialize (5,809 ms -> 0.459 ms):
-- the MV is NOT granted to anon; the VIEW keeps its name, column list,
-- security_invoker=on and grants, so no consumer changes.
--
-- RESULT: 16,992 ms -> 1.468 ms. Output byte-identical (md5 of the full board
-- unchanged at 6d87a82f2b188a9d446c8c8cd8180f3f, 178 rows).
--
-- Staleness bounded to 1h on a 180d/90d window.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-refresh-perfect-mint-premiums');
--   CREATE OR REPLACE VIEW public.topshot_perfect_mint_premiums_board AS
--     <the WITH ed_med ... SELECT body reproduced verbatim below>;
--   ALTER VIEW public.topshot_perfect_mint_premiums_board SET (security_invoker = on);
--   GRANT SELECT ON public.topshot_perfect_mint_premiums_board TO anon, authenticated, service_role;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_perfect_mint_premiums_board;

SET LOCAL statement_timeout = '600s';

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_topshot_perfect_mint_premiums_board AS
WITH ed_med AS (
  SELECT s.edition_id,
         percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision)) AS edition_median,
         count(*) AS edition_sales_180d
    FROM sales s
   WHERE s.collection = 'nba_top_shot'::text
     AND s.sold_at >= (now() - '180 days'::interval)
     AND s.price_usd > 0.50
   GROUP BY s.edition_id
  HAVING count(*) >= 15
), perfect AS (
  SELECT DISTINCT ON (s.edition_id) s.edition_id,
         s.price_usd AS perfect_price,
         s.sold_at AS perfect_sold_at,
         s.moment_id,
         s.nft_id,
         s.serial_number
    FROM sales s
    JOIN editions e2 ON e2.id = s.edition_id
   WHERE s.collection = 'nba_top_shot'::text
     AND e2.circulation_count > 1
     AND s.serial_number = e2.circulation_count
     AND s.sold_at >= (now() - '90 days'::interval)
     AND s.price_usd > 0.50
   ORDER BY s.edition_id, s.sold_at DESC
)
SELECT e.id AS edition_id,
       e.external_id,
       e.player_name,
       e.set_name,
       e.tier::text AS tier,
       e.circulation_count,
       e.thumbnail_url,
       p.moment_id,
       p.nft_id,
       p.serial_number AS perfect_serial,
       round(m.edition_median::numeric, 2) AS edition_median_usd,
       round(p.perfect_price::numeric, 2) AS perfect_last_sale_usd,
       round((p.perfect_price::double precision / m.edition_median)::numeric, 1) AS premium_multiple,
       p.perfect_sold_at,
       m.edition_sales_180d,
       (EXISTS (SELECT 1 FROM topshot_conflated_editions c WHERE c.edition_id = e.id)) AS is_conflated
  FROM perfect p
  JOIN ed_med m ON m.edition_id = p.edition_id
  JOIN editions e ON e.id = p.edition_id
 WHERE e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text
   AND e.thumbnail_url IS NOT NULL
   AND m.edition_median >= 0.75::double precision
   AND (p.perfect_price::double precision / m.edition_median) >= 5::double precision;

-- Required for REFRESH ... CONCURRENTLY. edition_id is unique: `perfect` is
-- DISTINCT ON (edition_id) and both joins are to unique keys (verified live:
-- 178 rows / 178 distinct edition_id).
CREATE UNIQUE INDEX IF NOT EXISTS mv_topshot_perfect_mint_premiums_board_edition_id_key
  ON public.mv_topshot_perfect_mint_premiums_board (edition_id);

-- A new MATERIALIZED VIEW inherits Supabase's default per-role anon/authenticated
-- grant exactly like a table or view. Verified live: this MV was the ONLY one of
-- 25 public MVs with anon SELECT = true until revoked. Consequence (accepted,
-- matches the market_index_daily precedent): the published view is
-- security_invoker=on, so an ANON PostgREST read of the view now fails with
-- "permission denied for materialized view". The product is unaffected -- every
-- consumer goes through supabaseAdmin (service_role); verified by grep that
-- there are no client-side/anon readers.
REVOKE SELECT ON public.mv_topshot_perfect_mint_premiums_board FROM anon, authenticated;

COMMENT ON MATERIALIZED VIEW public.mv_topshot_perfect_mint_premiums_board IS
  'Backing store for public.topshot_perfect_mint_premiums_board. Refreshed hourly by pg_cron rpc-refresh-perfect-mint-premiums. Read through the VIEW, never directly -- the view is the published name so a predicate change lands in one place.';

-- Swap the published view onto the MV. Column names/types/order are identical
-- (CREATE OR REPLACE VIEW enforces this). ORDER BY preserved from the original.
CREATE OR REPLACE VIEW public.topshot_perfect_mint_premiums_board AS
SELECT edition_id,
       external_id,
       player_name,
       set_name,
       tier,
       circulation_count,
       thumbnail_url,
       moment_id,
       nft_id,
       perfect_serial,
       edition_median_usd,
       perfect_last_sale_usd,
       premium_multiple,
       perfect_sold_at,
       edition_sales_180d,
       is_conflated
  FROM public.mv_topshot_perfect_mint_premiums_board
 ORDER BY premium_multiple DESC;

-- CREATE OR REPLACE VIEW wipes reloptions -- re-assert.
ALTER VIEW public.topshot_perfect_mint_premiums_board SET (security_invoker = on);
GRANT SELECT ON public.topshot_perfect_mint_premiums_board TO anon, authenticated, service_role;

-- Hourly CONCURRENTLY refresh. CONCURRENTLY (not a plain REFRESH) so the ~17s
-- rebuild never takes an ACCESS EXCLUSIVE lock that would hang the public board
-- for its duration. Minute 17 keeps it off the :07 market-index refresh and the
-- :23/:53 pack crons. Verified: a CONCURRENTLY refresh completes successfully.
SELECT cron.schedule(
  'rpc-refresh-perfect-mint-premiums',
  '17 * * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_perfect_mint_premiums_board'
);

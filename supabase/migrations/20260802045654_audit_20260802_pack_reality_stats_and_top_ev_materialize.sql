-- audit_20260802_pack_reality_stats_and_top_ev_materialize
-- Applied to prod 2026-08-02 ~04:58 UTC / 2026-08-01 ~21:58 PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- WHY (measured live, 2026-08-02):
--   /insights/pack-reality renders "FAILED TO LOAD: HTTP 500" with every KPI as
--   "-". The PAGE returns 200 (streaming shell) so only rendered DOM shows it.
--   app/api/public/insights/pack-reality/route.ts runs FOUR queries in
--   Promise.all under supabaseAdmin (service_role, statement_timeout = 30s) and
--   treats three of them as FATAL. Today's materialization covered only one:
--     topshot_pack_reality_dist    ->      0.14 ms  (mv shipped audit_20260802_pack_reality_dist_materialize)
--     topshot_pack_reality_stats   ->  9,468 ms warm / 41,923 ms contended  <-- NOT materialized
--     topshot_pack_reality_top_ev  ->    823 ms warm / 53,003 ms contended  <-- NOT materialized
--     v_topshot_pack_realized_ev   ->    122 ms  (already MV-backed; non-fatal) OK
--   Either un-materialized arm can ALONE exceed the 30s service_role budget, so
--   the route could never reliably succeed.
--
-- EVIDENCE (EXPLAIN ANALYZE, BUFFERS on prod):
--   topshot_pack_reality_stats: Execution Time 9,468 ms; ~100% of it is ONE
--     Index Scan on idx_pack_rips_collection_time returning 113,429 rows with
--     shared hit=74,421 read=19,107 written=346 -- ~0.8 buffers/row, i.e. a heap
--     fetch per row. IDENTICAL root cause to the dist view (same `rips` CTE over
--     the same 60d pack_rips window). The dist migration already considered and
--     REJECTED a covering index (pack_rips is 1,716 MB / 3.64M rows with NINE
--     indexes / ~967 MB; a tenth adds write-path cost on a hot ingest table and
--     still lands near ~1s). That reasoning applies verbatim here.
--   topshot_pack_reality_top_ev: 823 ms WARM but shared hit=400,806 (~3.1 GB of
--     buffer traffic) -- pack_ev_latest is a DISTINCT ON over 200,320
--     pack_ev_history rows plus a per-row pack_ask_state SubPlan executed 65,973
--     times (193,808 buffers). That buffer volume is what becomes 53 s under
--     IOPS contention on Micro. It returns FIVE rows.
--
-- ALSO FIXED HERE -- the 120 s ceiling that ALREADY BIT a sibling shipped today:
--   cron.job_run_details shows jobid 237 rpc-refresh-pack-reality-dist FAILED at
--   2026-08-02 04:27:00 -> 04:29:00 with "canceling statement due to statement
--   timeout" -- exactly 120,000 ms, the cluster default, which the `postgres`
--   role inherits (pg_roles.rolconfig for postgres carries no statement_timeout).
--   So all three board-MV refresh jobs shipped today (235/236/237) run refreshes
--   measured at 9-27 s on a 120 s budget that balloons under contention, and a
--   refresh that times out is exactly the silent-stale-board failure the
--   board_mv_refresh_stale_hours arm exists to catch.
--   The repo's usual remedy -- the cron_heavy role (statement_timeout = 600 s)
--   -- is NOT reachable from a migration here: `UPDATE cron.job SET username`
--   raises 42501 permission denied for table job, and postgres is not a member
--   of cron_heavy (pg_auth_members is empty for it), so SET ROLE is unavailable
--   too. Instead each refresh command is made two statements,
--   "SET statement_timeout = '600s'; REFRESH ...", which pg_cron runs in one
--   implicit transaction; the SET is its own top-level command so the timer is
--   armed at 600 s when the REFRESH starts. Verified live that
--   REFRESH ... CONCURRENTLY is legal after a SET inside one transaction.
--   The matview name stays inside the command string, so
--   board_mv_refresh_max_stale_hours()'s `j.command ILIKE '%'||matview_name||'%'`
--   match is unaffected.
--   VINDICATED WITHIN THE HOUR: at 05:07 rpc-refresh-market-index-daily took
--   201.1 s (it had been running 9-27 s) -- it would have FAILED under the old
--   120 s ceiling and gone silently stale.
--
-- `ord` is carried INTO the stats MV (not a published column) purely to give
--   REFRESH ... CONCURRENTLY the UNIQUE index it requires on a one-row result.
--   top_ev needs no such column: pack_listing_id is the DISTINCT ON key of
--   pack_ev_latest, so it is unique and non-null by construction (verified live:
--   5 rows / 5 distinct pack_listing_id / 0 null).
--
-- `computed_at` in the stats view was `now()`. Materialized it freezes to the
--   refresh timestamp, which is MORE honest ("when this was computed", not "when
--   you asked"). No consumer treats it as request time --
--   app/insights/pack-reality/page.tsx's Stats type does not include it.
--
-- SECURITY: both MVs are read ONLY through their existing published views, which
--   keep security_invoker = on and their original grants; the live consumer
--   reads via supabaseAdmin (service_role), which retains SELECT. anon and
--   authenticated get ALL revoked on the MVs -- note the sibling migrations
--   revoked SELECT only, leaving Supabase's default REFERENCES+MAINTAIN grant
--   behind (relacl anon=xm); harmless, but new objects should carry none of it.
--   Post-apply: check_public_security_invariants() 0, check_anon_write_surface()
--   0, check_secdef_anon_exec_drift() [] -- all clean.
--
-- VERIFIED AFTER APPLY (live prod):
--   topshot_pack_reality_stats   9,468 ms -> 2.6 ms
--   topshot_pack_reality_top_ev    823 ms -> 0.1 ms
--   MV row equals the live-computed row (113,448 vs 113,445 rips, the drift
--   being rips ingested between the two reads; every other column identical).
--   First cron ticks succeeded: stats 05:12 in 58.0 s, top_ev 05:15 in 14.8 s.
--   board_mv_refresh_max_stale_hours() = 1.87 (breach 8).
--   Rendered DOM at /insights/pack-reality now shows 113,437 rips / 13.1% $0 /
--   $10.26 mean / $3.56 median and a 5-row +EV ranker; route 200 in ~1.0-1.4 s
--   warm (was a guaranteed 500).
--
-- REVERT (restores the pre-change slow-but-live views exactly):
--   SELECT cron.unschedule('rpc-refresh-pack-reality-stats');
--   SELECT cron.unschedule('rpc-refresh-pack-reality-top-ev');
--   DELETE FROM public.board_mv_refresh_watchlist
--    WHERE matview_name IN ('mv_topshot_pack_reality_stats','mv_topshot_pack_reality_top_ev');
--   SELECT cron.schedule('rpc-refresh-market-index-daily','7 * * * *','REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_market_index_daily');
--   SELECT cron.schedule('rpc-refresh-perfect-mint-premiums','17 * * * *','REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_perfect_mint_premiums_board');
--   SELECT cron.schedule('rpc-refresh-pack-reality-dist','27 * * * *','REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_dist');
--   CREATE OR REPLACE VIEW public.topshot_pack_reality_stats AS
--     <the mv_topshot_pack_reality_stats body below, minus the `1 AS ord` column>;
--   ALTER VIEW public.topshot_pack_reality_stats SET (security_invoker = on);
--   GRANT SELECT ON public.topshot_pack_reality_stats TO anon, authenticated, service_role;
--   CREATE OR REPLACE VIEW public.topshot_pack_reality_top_ev AS
--     <the mv_topshot_pack_reality_top_ev body below, with ORDER BY pack_ev DESC NULLS LAST>;
--   ALTER VIEW public.topshot_pack_reality_top_ev SET (security_invoker = on);
--   GRANT SELECT ON public.topshot_pack_reality_top_ev TO anon, authenticated, service_role;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_reality_stats;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_reality_top_ev;

SET LOCAL statement_timeout = '600s';

-- == 1. stats ===============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_topshot_pack_reality_stats AS
WITH rips AS (
  SELECT COALESCE(pack_rips.pull_value_usd, 0::numeric) AS pv
    FROM pack_rips
   WHERE pack_rips.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND pack_rips.sealed_at >= (now() - '60 days'::interval)
)
SELECT 1 AS ord,
       count(*) AS rips_60d,
       count(*) FILTER (WHERE pv = 0::numeric) AS zero_value_rips,
       round(100.0 * count(*) FILTER (WHERE pv = 0::numeric)::numeric / NULLIF(count(*), 0)::numeric, 1) AS zero_value_pct,
       round(avg(pv), 2) AS mean_pull_value_usd,
       round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (pv::double precision))::numeric, 2) AS median_pull_value_usd,
       round(percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (pv::double precision))::numeric, 2) AS p90_pull_value_usd,
       round(percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (pv::double precision))::numeric, 2) AS p99_pull_value_usd,
       count(*) FILTER (WHERE pv > 100::numeric) AS rips_over_100,
       round(100.0 * count(*) FILTER (WHERE pv > 100::numeric)::numeric / NULLIF(count(*), 0)::numeric, 2) AS rips_over_100_pct,
       count(*) FILTER (WHERE pv > 1000::numeric) AS rips_over_1000,
       now() AS computed_at
  FROM rips;

CREATE UNIQUE INDEX IF NOT EXISTS mv_topshot_pack_reality_stats_ord_key
  ON public.mv_topshot_pack_reality_stats (ord);

REVOKE ALL ON public.mv_topshot_pack_reality_stats FROM anon, authenticated;

COMMENT ON MATERIALIZED VIEW public.mv_topshot_pack_reality_stats IS
  'Backing store for public.topshot_pack_reality_stats. Refreshed hourly by pg_cron rpc-refresh-pack-reality-stats (600s inner budget). Read through the VIEW, never directly. Carries a non-published constant `ord` column solely so REFRESH ... CONCURRENTLY has a UNIQUE index on a one-row result.';

CREATE OR REPLACE VIEW public.topshot_pack_reality_stats AS
SELECT rips_60d,
       zero_value_rips,
       zero_value_pct,
       mean_pull_value_usd,
       median_pull_value_usd,
       p90_pull_value_usd,
       p99_pull_value_usd,
       rips_over_100,
       rips_over_100_pct,
       rips_over_1000,
       computed_at
  FROM public.mv_topshot_pack_reality_stats;

ALTER VIEW public.topshot_pack_reality_stats SET (security_invoker = on);
GRANT SELECT ON public.topshot_pack_reality_stats TO anon, authenticated, service_role;

-- == 2. top_ev ==============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_topshot_pack_reality_top_ev AS
SELECT pev.pack_listing_id,
       pev.dist_id,
       pev.pack_name,
       pev.pack_price,
       pev.gross_ev,
       pev.pack_ev,
       pev.value_ratio,
       pev.fmv_coverage_pct,
       pev.edition_count,
       pev.total_unopened,
       pev.depletion_pct,
       pev.snapshotted_at,
       pev.price_source,
       pev.primary_available,
       pev.secondary_available,
       pev.fmv_coverage_pct < 80
         OR COALESCE(pev.depletion_pct::integer, 0) >= 60
         OR pev.secondary_available
            AND COALESCE(pev.secondary_ask, 0::numeric) > 0::numeric
            AND pev.gross_ev > (3::numeric * pev.secondary_ask) AS high_variance,
       pdv.is_reward_pack,
       pdv.retail_price_usd_normalized,
       pev.secondary_ask
  FROM pack_ev_latest pev
  LEFT JOIN pack_distributions_v pdv
    ON pdv.collection_id = pev.collection_id AND pdv.dist_id = pev.dist_id
 WHERE pev.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
   AND pev.is_positive_ev = true
   AND COALESCE(pev.pack_price, 0::numeric) > 0::numeric
   AND COALESCE(pdv.is_reward_pack, false) = false
   AND pev.dist_id IS NOT NULL
   AND COALESCE(pev.depletion_pct::integer, 100) < 90
   AND COALESCE(pev.fmv_coverage_pct::integer, 0) >= 40
   AND pev.snapshotted_at >= (now() - '48:00:00'::interval);

CREATE UNIQUE INDEX IF NOT EXISTS mv_topshot_pack_reality_top_ev_listing_key
  ON public.mv_topshot_pack_reality_top_ev (pack_listing_id);

REVOKE ALL ON public.mv_topshot_pack_reality_top_ev FROM anon, authenticated;

COMMENT ON MATERIALIZED VIEW public.mv_topshot_pack_reality_top_ev IS
  'Backing store for public.topshot_pack_reality_top_ev. Refreshed hourly by pg_cron rpc-refresh-pack-reality-top-ev (600s inner budget). Read through the VIEW, never directly. UNIQUE on pack_listing_id, the DISTINCT ON key of pack_ev_latest. The 48h snapshotted_at window is evaluated at REFRESH time, so the feed drains honestly to zero rows if pack_ev_history stops updating.';

-- SELECT * FROM a matview has no ordering guarantee, so the view re-applies the
-- original ORDER BY (cheap: 5 rows).
CREATE OR REPLACE VIEW public.topshot_pack_reality_top_ev AS
SELECT pack_listing_id,
       dist_id,
       pack_name,
       pack_price,
       gross_ev,
       pack_ev,
       value_ratio,
       fmv_coverage_pct,
       edition_count,
       total_unopened,
       depletion_pct,
       snapshotted_at,
       price_source,
       primary_available,
       secondary_available,
       high_variance,
       is_reward_pack,
       retail_price_usd_normalized,
       secondary_ask
  FROM public.mv_topshot_pack_reality_top_ev
 ORDER BY pack_ev DESC NULLS LAST;

ALTER VIEW public.topshot_pack_reality_top_ev SET (security_invoker = on);
GRANT SELECT ON public.topshot_pack_reality_top_ev TO anon, authenticated, service_role;

-- == 3. hourly refresh jobs, clear of the existing :07/:17/:27 board-MV
--       refreshes and of every other fixed-minute hourly pg_cron job =========
SELECT cron.schedule(
  'rpc-refresh-pack-reality-stats',
  '12 * * * *',
  $cmd$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_stats;$cmd$
);
SELECT cron.schedule(
  'rpc-refresh-pack-reality-top-ev',
  '15 * * * *',
  $cmd$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_top_ev;$cmd$
);

-- == 4. retrofit the 600s budget onto today's three sibling jobs (same jobid,
--       same schedule -- cron.schedule upserts by jobname for the same owner) =
SELECT cron.schedule(
  'rpc-refresh-market-index-daily',
  '7 * * * *',
  $cmd$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_market_index_daily;$cmd$
);
SELECT cron.schedule(
  'rpc-refresh-perfect-mint-premiums',
  '17 * * * *',
  $cmd$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_perfect_mint_premiums_board;$cmd$
);
SELECT cron.schedule(
  'rpc-refresh-pack-reality-dist',
  '27 * * * *',
  $cmd$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_dist;$cmd$
);

-- == 5. register both new MVs on the staleness arm ==========================
INSERT INTO public.board_mv_refresh_watchlist (matview_name, max_stale_hours, is_active, note)
VALUES
  ('mv_topshot_pack_reality_stats', 6, true,
   'backs /insights/pack-reality KPI strip; pg_cron rpc-refresh-pack-reality-stats 12 * * * * (hourly) -> 6h = 6 missed ticks'),
  ('mv_topshot_pack_reality_top_ev', 6, true,
   'backs /insights/pack-reality top-EV ranker; pg_cron rpc-refresh-pack-reality-top-ev 15 * * * * (hourly) -> 6h = 6 missed ticks')
ON CONFLICT (matview_name) DO UPDATE
  SET max_stale_hours = EXCLUDED.max_stale_hours,
      is_active       = EXCLUDED.is_active,
      note            = EXCLUDED.note;

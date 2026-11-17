-- audit_20260802_pack_reality_dist_materialize
-- Applied to prod 2026-08-02 03:02 UTC / 2026-08-01 20:02 PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- WHY: measured live: Execution Time 9,798 ms for SIX rows, 74,345 shared hit +
-- 19,255 read + temp read 1,362 / written 227. Consumer
-- /api/public/insights/pack-reality is fail-soft, so contention renders an empty
-- histogram rather than erroring -- the same silent-lie class as candy_holder_board.
--
-- NOTE -- the 2026-08-02 handoff's diagnosis was WRONG and is corrected here. It
-- said the cost was the `rips` CTE being "CTE-scanned seven times, spilling to
-- temp each pass". Measured per-node, the six re-scans cost ~14-17 ms EACH
-- (~100 ms total, served from temp). 9,509 ms of the 9,798 ms -- 97% -- is the
-- SINGLE first pass: an Index Scan on idx_pack_rips_collection_time returning
-- 113,439 rows at ~0.8 buffers/row (a heap fetch per row), 19,255 cold reads.
--
-- A covering index was considered and REJECTED: pack_rips is 1,716 MB / 3.64M
-- rows and already carries NINE indexes (~967 MB). A tenth (~140 MB) would add
-- write-path cost on a hot ingest table and, at 92.7% all-visible, still
-- heap-fetch ~7% of rows -- landing near ~1s, not <100ms. The MV costs zero
-- write-path overhead and one 9.8s refresh per hour.
--
-- `ord` is carried INTO the MV (it is not a published column) purely so the view
-- can ORDER BY it -- SELECT * FROM an MV has no ordering guarantee, and the
-- histogram must render $0 -> $1k+ in order.
--
-- RESULT: 9,798 ms -> 0.141 ms. All six rows identical to the pre-change
-- baseline (13.2 / 71.2 / 12.9 / 1.4 / 1.2 / 0.1 pct, same counts, same order).
--
-- Staleness bounded to 1h on a 60-day distribution.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-refresh-pack-reality-dist');
--   CREATE OR REPLACE VIEW public.topshot_pack_reality_dist AS
--     <the body below, minus the `ord` column, wrapped in the original
--      "SELECT bucket, lower_bound, upper_bound, rips, pct FROM (...) sub ORDER BY ord">;
--   ALTER VIEW public.topshot_pack_reality_dist SET (security_invoker = on);
--   GRANT SELECT ON public.topshot_pack_reality_dist TO anon, authenticated, service_role;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_reality_dist;

SET LOCAL statement_timeout = '600s';

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_topshot_pack_reality_dist AS
WITH rips AS (
  SELECT COALESCE(pack_rips.pull_value_usd, 0::numeric) AS pv
    FROM pack_rips
   WHERE pack_rips.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND pack_rips.sealed_at >= (now() - '60 days'::interval)
), total AS (
  SELECT count(*)::numeric AS n FROM rips
)
SELECT 1 AS ord, '$0'::text AS bucket, 0::numeric AS lower_bound, 0::numeric AS upper_bound,
       count(*) FILTER (WHERE rips.pv = 0::numeric) AS rips,
       round(100.0 * count(*) FILTER (WHERE rips.pv = 0::numeric)::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1) AS pct
  FROM rips
UNION ALL
SELECT 2, '$0–$10'::text, 0.01, 10,
       count(*) FILTER (WHERE rips.pv > 0::numeric AND rips.pv <= 10::numeric),
       round(100.0 * count(*) FILTER (WHERE rips.pv > 0::numeric AND rips.pv <= 10::numeric)::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
  FROM rips
UNION ALL
SELECT 3, '$10–$50'::text, 10.01, 50,
       count(*) FILTER (WHERE rips.pv > 10::numeric AND rips.pv <= 50::numeric),
       round(100.0 * count(*) FILTER (WHERE rips.pv > 10::numeric AND rips.pv <= 50::numeric)::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
  FROM rips
UNION ALL
SELECT 4, '$50–$100'::text, 50.01, 100,
       count(*) FILTER (WHERE rips.pv > 50::numeric AND rips.pv <= 100::numeric),
       round(100.0 * count(*) FILTER (WHERE rips.pv > 50::numeric AND rips.pv <= 100::numeric)::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
  FROM rips
UNION ALL
SELECT 5, '$100–$1k'::text, 100.01, 1000,
       count(*) FILTER (WHERE rips.pv > 100::numeric AND rips.pv <= 1000::numeric),
       round(100.0 * count(*) FILTER (WHERE rips.pv > 100::numeric AND rips.pv <= 1000::numeric)::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
  FROM rips
UNION ALL
SELECT 6, '$1k+'::text, 1000.01, NULL::numeric,
       count(*) FILTER (WHERE rips.pv > 1000::numeric),
       round(100.0 * count(*) FILTER (WHERE rips.pv > 1000::numeric)::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
  FROM rips;

CREATE UNIQUE INDEX IF NOT EXISTS mv_topshot_pack_reality_dist_ord_key
  ON public.mv_topshot_pack_reality_dist (ord);

-- See the anon-grant note in the sibling premiums migration.
REVOKE SELECT ON public.mv_topshot_pack_reality_dist FROM anon, authenticated;

COMMENT ON MATERIALIZED VIEW public.mv_topshot_pack_reality_dist IS
  'Backing store for public.topshot_pack_reality_dist. Refreshed hourly by pg_cron rpc-refresh-pack-reality-dist. Read through the VIEW, never directly. Carries a non-published `ord` column so the view can guarantee histogram order.';

-- Swap the published view onto the MV. Same 5 columns, same types, same order;
-- `ord` stays internal.
CREATE OR REPLACE VIEW public.topshot_pack_reality_dist AS
SELECT bucket, lower_bound, upper_bound, rips, pct
  FROM public.mv_topshot_pack_reality_dist
 ORDER BY ord;

ALTER VIEW public.topshot_pack_reality_dist SET (security_invoker = on);
GRANT SELECT ON public.topshot_pack_reality_dist TO anon, authenticated, service_role;

-- Verified: a CONCURRENTLY refresh completes successfully.
SELECT cron.schedule(
  'rpc-refresh-pack-reality-dist',
  '27 * * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_dist'
);

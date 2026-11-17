-- audit_20260831_unmapped_backlog_growth_offset0_fence
-- anon-exec: refresh_unmapped_backlog_growth — pre-existing SECURITY DEFINER ACL is preserved by CREATE OR REPLACE;
-- this migration changes ONLY the tx CTE's scan shape. No signature, no proconfig, no grant change.
--
-- WHY: pg_cron jobid 261 `rpc-refresh-unmapped-backlog-growth` (`29 * * * *`, owner `postgres`) failed
-- 67 of 325 runs (20.6%) over 14 days. Split by MECHANISM rather than lumped:
--     7  `job startup timeout`  (16.5–41.2 s) — the fleet-wide worker-pool condition, NOT this job
--    51  statement timeout      (120.0–122.6 s)
--     9  statement timeout      (127.2–685.6 s) — same error; the excess over 120 s is QUEUE WAIT,
--                                                  which `cron.job_run_details` duration includes
-- ⚠ The binding ceiling is the DATABASE-level `statement_timeout = 120s` (source: configuration file),
-- NOT the function's own `SET statement_timeout = '90s'`, which is INERT on the pg_cron path — kills land
-- at 120.1 s, not 90. Job runs as `postgres`, which carries no role-level statement_timeout.
--
-- WHAT: an `OFFSET 0` optimization fence on the `tx` CTE's scan. Nothing else changes.
--
-- MEASURED 2026-08-31 in an IDLE window (pg_stat_activity io_wait 0, active 1 of 35 at the time of the reads),
-- three variants back-to-back, INTRA-PLAN attribution (the robust kind — no second run needed):
--   current  Index Scan on unmapped_sales_dedup_idx  -> 102,791 buffers / 10,725 ms   (99% of total time)
--   OFFSET 0 Seq Scan + HashAggregate                ->   9,296 buffers /  1,507 ms   (temp written 631)
--   AS MATERIALIZED                                  ->   9,296 buffers /  3,166 ms   (temp written 1,854)
-- ⭐ 11.1x fewer buffers. The mechanism: the index is (transaction_hash, nft_id, collection_id) and the
-- planner takes it to get transaction_hash PRESORTED for an Incremental Sort, then heap-fetches all
-- ~105k open rows in index order — against a table of only 9,296 pages, so EACH PAGE IS VISITED ~11
-- TIMES because index order does not match heap order (insert time). The same table seq-scans in 84 ms.
-- ⚠ NOT cache-flattered: the fenced plan read MORE from disk (3,668 vs 2,800) while touching 11x fewer
-- buffers, so the ratio is a work measure, not a cache outcome.
--
-- EQUIVALENCE PROVEN over the population before ship, both directions: orig 3 rows, fenced 3 rows,
-- `orig EXCEPT fenced` = 0, `fenced EXCEPT orig` = 0.
--
-- ⛔ DO NOT REMOVE THE `OFFSET 0` — it is load-bearing, and the function body says so at the site.
--
-- REVERT: re-apply the previous definition from
--   supabase/migrations/20260810030734_audit_20260809_unmapped_backlog_growth_precompute_cache.sql
-- (identical except the tx CTE reads `FROM public.unmapped_sales u WHERE u.resolved_at IS NULL`
--  directly, with no `OFFSET 0` subquery). Nothing else to unwind — no DDL, no data change.

CREATE OR REPLACE FUNCTION public.refresh_unmapped_backlog_growth()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  WITH tx AS (
    -- One row per (collection, transaction) over OPEN rows only. open_n > 1 marks a
    -- multi-NFT tx; those rows' price cannot be attributed per-NFT because
    -- decodeV1SaleTx returns a single gross DUC total for the whole transaction.
    --
    -- ⚠ THE `OFFSET 0` IS AN OPTIMIZATION FENCE AND IS LOAD-BEARING. DO NOT REMOVE IT.
    -- Without it the planner picks an Index Scan on unmapped_sales_dedup_idx
    -- (transaction_hash, nft_id, collection_id) to get transaction_hash PRESORTED and
    -- feed an Incremental Sort -- then heap-fetches every one of ~105k open rows in
    -- index order. Measured 2026-08-31 on an idle instance: 102,791 buffers / 10,725 ms
    -- against a table of only 9,296 pages, i.e. EACH PAGE VISITED ~11 TIMES, because
    -- index order (transaction_hash) does not match heap order (insert time).
    -- OFFSET 0 blocks subquery pull-up, so the scan is planned on its own and comes out
    -- as Seq Scan + HashAggregate: 9,296 buffers / 1,507 ms -- 11.1x fewer buffers.
    -- `AS MATERIALIZED` also works and is more self-documenting, but was measured SLOWER
    -- (3,166 ms, temp written 1,854 vs 631) because it round-trips every row through a
    -- tuplestore. Equivalence proven both directions (EXCEPT each way = 0) before ship.
    SELECT
      s.collection_id,
      count(*)                                                  AS open_n,
      count(*) FILTER (WHERE COALESCE(s.price_usd,0) = 0)       AS open_unpriced_n
    FROM (
      SELECT u.collection_id, u.transaction_hash, u.price_usd
      FROM public.unmapped_sales u
      WHERE u.resolved_at IS NULL
      OFFSET 0
    ) s
    GROUP BY s.collection_id, s.transaction_hash
  ), unspl AS (
    SELECT
      t.collection_id,
      COALESCE(sum(t.open_unpriced_n) FILTER (WHERE t.open_n > 1), 0)::bigint AS open_gross_unsplittable_rows
    FROM tx t
    GROUP BY t.collection_id
  ), per_collection AS (
    SELECT
      u.collection_id,
      count(*) FILTER (WHERE u.resolved_at IS NULL)                                 AS open_rows,
      count(*) FILTER (WHERE u.resolved_at IS NULL AND COALESCE(u.price_usd,0) > 0) AS open_priced_rows,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours')           AS inflow_24h,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours'
                         AND u.sold_at    > now() - interval '7 days')              AS inflow_24h_fresh,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours'
                         AND u.sold_at   <= now() - interval '7 days')              AS inflow_24h_backfill,
      count(*) FILTER (WHERE u.resolved_at  > now() - interval '24 hours')          AS outflow_24h,
      min(u.sold_at) FILTER (WHERE u.resolved_at IS NULL)                           AS oldest_open_sold_at
    FROM public.unmapped_sales u
    GROUP BY u.collection_id
  ), scored AS (
    SELECT
      c.slug AS collection,
      p.open_rows,
      p.open_priced_rows,
      COALESCE(x.open_gross_unsplittable_rows, 0)                  AS open_gross_unsplittable_rows,
      p.open_rows - COALESCE(x.open_gross_unsplittable_rows, 0)    AS open_actionable_rows,
      p.inflow_24h,
      p.inflow_24h_fresh,
      p.inflow_24h_backfill,
      p.outflow_24h,
      p.inflow_24h - p.outflow_24h AS net_24h,
      CASE WHEN p.inflow_24h > 0
           THEN round(p.outflow_24h::numeric / p.inflow_24h, 4) END AS drain_ratio,
      CASE WHEN p.outflow_24h > p.inflow_24h_fresh
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / (p.outflow_24h - p.inflow_24h_fresh), 1) END AS days_to_drain,
      p.oldest_open_sold_at,
      CASE
        WHEN (p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0)) >= 10000
             AND p.inflow_24h_fresh > p.outflow_24h THEN 'high'
        WHEN (p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0)) >=  1000
             AND p.inflow_24h_fresh > p.outflow_24h THEN 'medium'
        ELSE 'info'
      END AS severity
    FROM per_collection p
    JOIN public.collections c ON c.id = p.collection_id
    LEFT JOIN unspl x ON x.collection_id = p.collection_id
    WHERE p.open_rows >= 1000
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.open_rows DESC), '[]'::jsonb)
    INTO v_payload
    FROM scored s;

  INSERT INTO public.unmapped_backlog_growth_cache (id, payload, row_count, refreshed_at)
  VALUES (1, v_payload, jsonb_array_length(v_payload), now())
  ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload,
        row_count = EXCLUDED.row_count,
        refreshed_at = EXCLUDED.refreshed_at;

  RETURN v_payload;
END;
$function$;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_unmapped_backlog_growth'
      AND p.prosrc LIKE '%OFFSET 0%'
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the OFFSET 0 fence is not present in the deployed body';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_unmapped_backlog_growth'
      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: SECURITY DEFINER / search_path not preserved';
  END IF;
END
$mig$;

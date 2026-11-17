-- Precompute the unmapped_sales backlog-growth checker so the ALERT hot path never scans.
--
-- Problem (inbox 2026-08-09T2110Z, Candidate 1): get_pipeline_alerts() (45s cap) and
-- rpc_ops_snapshot() both call check_unmapped_backlog_growth(), which ran two full-table
-- scans of unmapped_sales (~130k rows / 144 MB, planner cost ~37,959) on EVERY call.
-- Under the platform's disk-IO-budget saturation that one arm blows the 45s statement
-- timeout and takes the WHOLE alert aggregation down with it — so alerts can silently
-- fail to fire during exactly the windows they matter most. This is the same class the
-- ledger records for /api/market and the nc1 public-board cache: the lever is precompute,
-- not a tier bump or a bigger statement_timeout.
--
-- Fix: relocate the exact heavy query (verbatim, so output shape/semantics are identical)
-- into a service-role-only refresh function that writes a singleton cache, scheduled hourly
-- OFF the alert path. The reader check_unmapped_backlog_growth() becomes an O(1) last-good
-- lookup. Fail-open by construction: if the refresh times out during saturation, the cache
-- simply stays last-good and the alert path still returns instantly (the backlog is a
-- slow-moving signal — inflow ~200/24h vs a ~96k open pile — so a stale reading is fine).
--
-- Revert: SELECT cron.unschedule('rpc-refresh-unmapped-backlog-growth');
--         DROP FUNCTION public.refresh_unmapped_backlog_growth();
--         DROP TABLE public.unmapped_backlog_growth_cache;
--         then restore check_unmapped_backlog_growth() to its inline-scan body from
--         migration 20260725171000_audit_20260725_sales_ingest_unresolved_park_table.sql.

-- 1. Singleton cache table (RLS on, anon/authenticated SELECT-revoked; only SECDEF fns +
--    service_role read it, matching the public_board_snapshots posture).
CREATE TABLE IF NOT EXISTS public.unmapped_backlog_growth_cache (
  id           smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  row_count    integer     NOT NULL DEFAULT 0,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.unmapped_backlog_growth_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.unmapped_backlog_growth_cache FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.unmapped_backlog_growth_cache TO service_role;

-- 2. Writer: runs the verbatim heavy query and upserts the singleton. SECDEF, service_role
--    only. 90s local timeout so a cold run can complete; a timeout just leaves last-good.
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
    SELECT
      u.collection_id,
      count(*)                                                  AS open_n,
      count(*) FILTER (WHERE COALESCE(u.price_usd,0) = 0)       AS open_unpriced_n
    FROM public.unmapped_sales u
    WHERE u.resolved_at IS NULL
    GROUP BY u.collection_id, u.transaction_hash
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
REVOKE EXECUTE ON FUNCTION public.refresh_unmapped_backlog_growth() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_unmapped_backlog_growth() TO service_role;

-- 3. Reader: now an O(1) last-good lookup. Signature/return type/ACL unchanged (already
--    anon/authenticated-revoked, service_role only), so get_pipeline_alerts() and
--    rpc_ops_snapshot() are drop-in — they still receive the identical jsonb array shape.
CREATE OR REPLACE FUNCTION public.check_unmapped_backlog_growth()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT payload FROM public.unmapped_backlog_growth_cache WHERE id = 1),
    '[]'::jsonb
  );
$function$;

-- 4. Hourly writer at :29 (a minute with zero existing pg_cron jobs — verified clear of
--    both fixed-minute jobs and every interval schedule — off the :00/:17/:20 pileups that
--    contend for the depleted disk-IO budget). Idempotent: cron.schedule replaces by name.
SELECT cron.schedule(
  'rpc-refresh-unmapped-backlog-growth',
  '29 * * * *',
  $$SELECT public.refresh_unmapped_backlog_growth();$$
);

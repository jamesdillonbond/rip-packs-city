-- audit_20261110_topshot_buyer_backfill_window_counts
--
-- WHY (Claude Code cloud, 2026-11-10 ~4:50 PM PT). The Top Shot buyer-backfill route's two telemetry counts through
-- PostgREST (`select("id", { count: "exact", head: true })`) sequentially scan sales_2023 + 2024 + 2025 in production:
-- the forward lane's below-floor count (payer NULL, [HIST_START, FORWARD_START)) read 176,178 blocks / 14.2 s on the
-- 4:34 PM PT run (= the three partitions' 175,958 heap pages; pg_stat_user_tables last_seq_scan on all three at
-- 4:34:22.144), and the historical lane's exhausted count (payer NOT NULL) ~73k blocks / 5-9 s, every 30 min each,
-- 841 / 3,112 calls since the stats reset. Every replica of the same statement from SQL -- custom plan, generic plan,
-- untyped params, EXPLAIN (GENERIC_PLAN) on the verbatim PostgREST text, as service_role -- uses the partial
-- null-buyer indexes at ~100 buffers, so the production plan choice could not be reproduced. This moves the counts
-- into one function whose plan is ours: the three counts measured together at 5,136 buffers (1.6 s cold) under a
-- forced generic plan as service_role. Collection is a literal so the nba_top_shot partial indexes are eligible.
--
-- anon-exec: revoked (topshot_buyer_backfill_window_counts) -- service-role telemetry for one admin route; REVOKE FROM PUBLIC, anon, authenticated; GRANT service_role.
-- REVERT: DROP FUNCTION public.topshot_buyer_backfill_window_counts(timestamptz, timestamptz, timestamptz);
--         (and restore the three head:true counts in app/api/admin/backfill-topshot-buyers/route.ts)

CREATE OR REPLACE FUNCTION public.topshot_buyer_backfill_window_counts(
  p_hist_start timestamptz,
  p_hist_end timestamptz,
  p_forward_start timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hist_exhausted bigint;
  v_forward_exhausted bigint;
  v_below_forward_floor bigint;
BEGIN
  -- decoded, no buyer recoverable, inside the historical window (the historical lane's exhausted_in_window)
  SELECT count(*) INTO v_hist_exhausted FROM public.sales
   WHERE collection = 'nba_top_shot' AND buyer_address IS NULL AND payer_address IS NOT NULL
     AND transaction_hash IS NOT NULL AND sold_at >= p_hist_start AND sold_at < p_hist_end;
  -- the same, at or above the forward floor (the forward lane's exhausted_in_window)
  SELECT count(*) INTO v_forward_exhausted FROM public.sales
   WHERE collection = 'nba_top_shot' AND buyer_address IS NULL AND payer_address IS NOT NULL
     AND transaction_hash IS NOT NULL AND sold_at >= p_forward_start;
  -- the forward lane's candidate predicate below its floor (owned by the historical lane)
  SELECT count(*) INTO v_below_forward_floor FROM public.sales
   WHERE collection = 'nba_top_shot' AND buyer_address IS NULL AND payer_address IS NULL
     AND transaction_hash IS NOT NULL AND sold_at >= p_hist_start AND sold_at < p_forward_start;
  RETURN jsonb_build_object(
    'hist_exhausted', v_hist_exhausted,
    'forward_exhausted', v_forward_exhausted,
    'below_forward_floor', v_below_forward_floor);
END;
$$;

REVOKE ALL ON FUNCTION public.topshot_buyer_backfill_window_counts(timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_buyer_backfill_window_counts(timestamptz, timestamptz, timestamptz) TO service_role;

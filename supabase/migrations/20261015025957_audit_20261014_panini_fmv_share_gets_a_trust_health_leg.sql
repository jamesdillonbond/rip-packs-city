-- audit_20261014_panini_fmv_share_gets_a_trust_health_leg
--
-- 2026-10-14 ~8:00 PM PT (Claude Code cloud; Trevor: "Do as much as you can" on the Panini review).
--
-- GAP (roadmap-status.md, "Panini is NOT in the headline table"): rpc_trust_health_precompute carried
-- no panini_fmv_high_med_share_pct at all, so Panini's share of the headline accuracy metric had no
-- owner — a step in it was visible to no standing instrument. Re-verified live 2026-10-14: the only
-- panini_* metrics are panini_sale_field_mapping_shortfall and panini_sale_price_capture_dry_days.
--
-- CHANGE: a new leg, a line-for-line mirror of rpc_thp_leg_pinnacle_fmv_share (same shape, same
-- 999-on-failure sentinel, same `WHEN query_canceled OR OTHERS` R118 handler), over the latest
-- panini_fmv_snapshots row per edition. NO_DATA and ASK_ONLY stay in the denominator — the same
-- definition Pinnacle uses (every priced object, not only the ones with sales).
--
-- MEASURED before apply (EXPLAIN ANALYZE, 2026-10-14 ~7:50 PM PT): one Index Scan on
-- idx_panini_fmv_edition_time, 150,472 rows -> 30,510 editions, 151,276 buffers, 1.12 s.
-- Hand value at the same time: 23.7 % (HIGH 2,122 + MEDIUM 5,104 of 30,497).
--
-- Schedule: pg_cron rpc-thp-leg-panini-fmv-share '57 3,9,15,21 * * *' as cron_heavy through
-- run_thp_leg_logged — two minutes after the Pinnacle share leg, the same six-hourly cadence.
-- rpc_trust_health_history picks the metric up generically (it copies every precompute row).
-- ⚠ cron.schedule here registers the job as postgres (the migration's role); the NEXT migration
-- (20261015030035) re-registers it under SET LOCAL ROLE cron_heavy, like every other leg.
--
-- anon-exec: revoked (rpc_thp_leg_panini_fmv_share) — new SECDEF writer; REVOKE FROM PUBLIC, anon, authenticated below; GRANT postgres, service_role, cron_heavy (the Pinnacle leg's grant set, read with has_function_privilege 2026-10-14).
--
-- Pinned: supabase/tests/rpc_thp_leg_panini_fmv_share.sql (registered in db-invariants-drift-guard).
--
-- REVERT:
--   SELECT cron.unschedule('rpc-thp-leg-panini-fmv-share');
--   DROP FUNCTION public.rpc_thp_leg_panini_fmv_share();
--   DELETE FROM public.rpc_trust_health_precompute WHERE metric = 'panini_fmv_high_med_share_pct';

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_panini_fmv_share()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '90s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (edition_id) edition_id, confidence
      FROM public.panini_fmv_snapshots
      ORDER BY edition_id, computed_at DESC
    )
    SELECT round(100.0 * count(*) FILTER (WHERE confidence::text IN ('HIGH','MEDIUM'))::numeric
                 / NULLIF(count(*), 0)::numeric, 1)
      INTO v FROM latest;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_fmv_high_med_share_pct', COALESCE(v, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_fmv_high_med_share_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_panini_fmv_share() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_panini_fmv_share() TO postgres, service_role, cron_heavy;

SELECT cron.schedule('rpc-thp-leg-panini-fmv-share', '57 3,9,15,21 * * *',
  $$SELECT public.run_thp_leg_logged('public.rpc_thp_leg_panini_fmv_share()'::regprocedure, 'thp-leg-panini-fmv-share');$$);

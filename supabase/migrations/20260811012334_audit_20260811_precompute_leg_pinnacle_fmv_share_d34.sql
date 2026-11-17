-- audit_20260811_precompute_leg_pinnacle_fmv_share_d34
--
-- Deep-audit D34: Pinnacle had no FMV confidence-share arm because its FMV
-- lives in pinnacle_fmv_history (render-keyed), not fmv_snapshots. The
-- precompute split (M1-M3, shipped 2026-08-10/11) cleared the prerequisite,
-- so this is now a clean 8th leg + one PERFORM…COMMIT line, isolated from the
-- other 7 legs by the per-leg-COMMIT design (a failure here writes 999 only to
-- its own metric and cannot roll back any other arm).
--
-- The leg mirrors the existing 5 *_fmv_high_med_share_pct metrics exactly:
-- TRACK-only (NOT an arm in v_rpc_trust_health — the board stays 38 arms; a
-- thin/dead market is a fact, not an alert), read via rpc_fmv_confidence_share()
-- and dashboards straight from rpc_trust_health_precompute. Cost measured 0.7-1.5s
-- (DISTINCT ON over ~124k rows on the (render_id, computed_at) PK; fully cached);
-- 90s budget is generous headroom.
--
-- ⚠ GRANT EXECUTE TO cron_heavy (the M3b lesson): the orchestrator runs as
-- cron_heavy and PERFORMs this leg, so cron_heavy needs EXECUTE on it even
-- though it is SECURITY DEFINER. anon/authenticated stay revoked.
--
-- Revert:
--   1) CREATE OR REPLACE the orchestrator without the pinnacle PERFORM line
--      (body in migration 20260810230106).
--   2) DROP FUNCTION public.rpc_thp_leg_pinnacle_fmv_share();
--   3) DELETE FROM public.rpc_trust_health_precompute WHERE metric='pinnacle_fmv_high_med_share_pct';

-- 1) the leg
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_pinnacle_fmv_share()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '90s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (render_id) render_id, fmv_confidence
      FROM public.pinnacle_fmv_history
      ORDER BY render_id, computed_at DESC
    )
    SELECT round(100.0 * count(*) FILTER (WHERE fmv_confidence IN ('HIGH','MEDIUM'))::numeric
                 / NULLIF(count(*), 0)::numeric, 1)
      INTO v FROM latest;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pinnacle_fmv_high_med_share_pct', COALESCE(v, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pinnacle_fmv_high_med_share_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.rpc_thp_leg_pinnacle_fmv_share() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_thp_leg_pinnacle_fmv_share() TO cron_heavy;

-- 2) wire it into the orchestrator (cheap-first: right after panini). CREATE OR
--    REPLACE preserves the procedure's existing grants (cron_heavy from M3b).
CREATE OR REPLACE PROCEDURE public.rpc_trust_health_precompute_refresh_p()
LANGUAGE plpgsql
AS $proc$
BEGIN
  PERFORM public.rpc_thp_leg_panini();              COMMIT;
  PERFORM public.rpc_thp_leg_pinnacle_fmv_share();  COMMIT;
  PERFORM public.rpc_thp_leg_pack_ev();             COMMIT;
  PERFORM public.rpc_thp_leg_fmv_sanity();          COMMIT;
  PERFORM public.rpc_thp_leg_serial_supply();       COMMIT;
  PERFORM public.rpc_thp_leg_fmv_coverage();        COMMIT;
  PERFORM public.rpc_thp_leg_board_liveness();      COMMIT;
  PERFORM public.rpc_thp_leg_impossible_parallel(); COMMIT;
END;
$proc$;

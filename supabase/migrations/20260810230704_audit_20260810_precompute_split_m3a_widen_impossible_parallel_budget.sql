-- audit_20260810_precompute_split_m3a_widen_impossible_parallel_budget
--
-- D34-prerequisite precompute split, stage M3a (DDL half of the cutover; the
-- cron half is done via execute_sql since apply_migration lacks cron.job priv,
-- and is recorded in the ledger). Plan: docs/audits/precompute-split-plan-2026-08-10.md.
--
-- Raises the impossible_parallel leg budget 300s→480s. In the cheapest-first
-- orchestrator order this leg runs LAST (most connection-contended) and cost
-- ~225s even on a healthy tick, so a 300s cap was only 1.33× headroom and a
-- saturated tick could exceed it and write a FALSE 999 (which pages, breach_at
-- 3). Per the plan's rule — never set a budget below the leg's saturated cost.
-- Only the SET statement_timeout clause changes; the body is byte-identical to M1.
--
-- Revert: re-apply the M1 body (statement_timeout '300s').

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '480s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT count(*)::numeric INTO v
    FROM public.editions e
    JOIN public.sales s ON s.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id::text ~ '::'::text
      AND e.circulation_count > 0
      AND s.serial_number > e.circulation_count;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

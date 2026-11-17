-- Leg 324 (rpc_thp_leg_impossible_parallel) stops reading 999 for ~19 h at every month boundary.
--
-- Filed by the daytime monitor 2026-10-01T0314Z: the arm read 999 (BREACH) at 01:52Z on 10-01
-- because no 2026-09 baseline row existed yet. The filing's mechanism ("the rotation never inserts
-- the newly-closed month") is WRONG — rpc_impossible_parallel_refresh_stalest_baseline sorts a
-- month with no row NULLS FIRST and upserts it, and did so at 19:22Z on 10-01 (2026-09 value 0,
-- 4,365 ms). The real defect is the window between: from 00:00Z on the 1st until the first
-- rotation (19:22Z, 12:22 PM PT), the leg's "every closed month must have a row" check fails, so
-- three ticks (01:52, 07:52, 13:52Z) publish the 999 sentinel every month. The data was clean (0).
--
-- Fix: when ONLY the just-closed month lacks its row, the leg counts that month live (the live
-- slice starts at last month instead of this month). Cost: one month's probe — 2026-09 took
-- 4,365 ms in the rotation, against the 480 s statement budget. Any OLDER missing month still
-- fails the completeness check ⇒ 999: never a partial sum published as the whole.
--
-- EXIT: on 2026-11-01 the 01:52Z / 07:52Z / 13:52Z ticks of jobid 324 write a non-999 value
--   (`SELECT value, computed_at FROM rpc_trust_health_precompute WHERE metric='topshot_impossible_parallel_serials'`)
--   before the 19:22Z rotation inserts 2026-10.
-- FALSIFIER: a 999 on 11-01 before 19:22Z with a pipeline_runs thp-leg-impossible-parallel
--   error other than 57014 ⇒ the fallback branch is wrong; a 57014 ⇒ the two-month live slice
--   does not fit 480 s and the rotation must instead run once just after 00:00Z on the 1st.
-- REVERT: re-apply the leg body from 20260920151857.
--
-- anon-exec: intentional — same signature, the leg keeps its ACL (cron_heavy + service_role only) (rpc_thp_leg_impossible_parallel)

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '480s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric; v_base numeric; v_months int; v_want int; v_cut date;
BEGIN
  BEGIN
    -- Every closed month (2020-01 .. last month) must have a baseline row, or the arm is
    -- unmeasured (999) — never a partial sum published as the whole. ONE exception: the
    -- just-closed month, whose row the daily rotation only inserts at 19:22Z on the 1st, is
    -- counted live until then (v_cut moves back a month), so a month boundary is not a 999.
    v_cut := date_trunc('month', now())::date;
    IF NOT EXISTS (SELECT 1 FROM public.rpc_impossible_parallel_baseline
                   WHERE period_start = (v_cut - interval '1 month')::date) THEN
      v_cut := (v_cut - interval '1 month')::date;
    END IF;
    v_want := (extract(year FROM v_cut)::int - 2020) * 12 + extract(month FROM v_cut)::int - 1;
    SELECT count(*), coalesce(sum(b.value), 0) INTO v_months, v_base
    FROM public.rpc_impossible_parallel_baseline b
    WHERE b.period_start >= '2020-01-01' AND b.period_start < v_cut;
    IF v_months <> v_want THEN
      RAISE EXCEPTION 'impossible-parallel baseline incomplete: % of % closed months', v_months, v_want;
    END IF;
    v := v_base + public.rpc_impossible_parallel_count(v_cut::timestamptz, '2100-01-01'::timestamptz);
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.rpc_thp_leg_impossible_parallel()'::regprocedure;
  IF strpos(v_src, 'just-closed month') = 0 THEN RAISE EXCEPTION 'leg lacks the just-closed-month fallback'; END IF;
  IF has_function_privilege('anon', 'public.rpc_thp_leg_impossible_parallel()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (leg)'; END IF;
END $$;

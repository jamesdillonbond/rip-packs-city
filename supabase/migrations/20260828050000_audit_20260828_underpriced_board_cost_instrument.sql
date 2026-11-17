-- audit_20260828_underpriced_board_cost_instrument
--
-- RECORD FILE for objects created LIVE from a Cowork cloud session on
-- 2026-08-28 ~04:58Z via `execute_sql`. Temporary instrument; self-retires.
--
-- ⚠ SCOPE: that session could not push (cloud git proxy, "not in this session's
-- authorized repository set"). A fact about THAT session. Trevor's machine and
-- Claude Code push normally via the PAT in remote.origin.pushurl. COMMIT AS USUAL.
--
-- WHY. known-issues #39 option 1 -- adding the PUBLIC underpriced-serials board to
-- the light warmer -- shipped 2026-08-26 with an explicit falsifier:
--
--   "if /api/public/insights/underpriced-serials 503s or runs multi-second again
--    during business hours, the */10 cadence is not enough against buffer eviction
--    and the answer is the snapshot cache, NOT a shorter warm interval."
--
-- That falsifier has been UNEVALUATED for two days, and the reason is an
-- instrument gap: /api/cron/warm writes NO pipeline_runs row (it returns JSON and
-- console.logs), so there is no DB-side way to ask whether the warmer is working.
-- pg_stat_statements holds only CUMULATIVE counters since the 2026-08-12 reset,
-- which cannot separate post-ship behaviour from the pre-ship history it is
-- averaged with.
--
-- ⭐ Sampling the cumulative counters makes them differenceable: between any two
-- rows, d_total_ms/d_calls is the PER-INTERVAL mean and d_disk_reads/d_calls is
-- reads per call -- the two numbers the falsifier actually turns on.
--
-- ⛔ Deliberately NOT shipped alongside this: a materialized view for the board
-- (#39 option 3). It is a public PRICING surface with three named risks, the
-- decision is a product call, and one reading is not a basis for it. This
-- instrument exists to make that call cheap, not to pre-empt it.
--
-- Baseline at creation: calls 681, total_exec_time 3,148,564 ms, shared_blks_read
-- 217,182 (cumulative mean 4,623 ms, 319 reads/call).
--
-- READ IT WITH:
--   SELECT at,
--          calls - lag(calls) OVER (ORDER BY at)                                   AS d_calls,
--          round((total_ms - lag(total_ms) OVER (ORDER BY at))::numeric
--                / nullif(calls - lag(calls) OVER (ORDER BY at), 0))               AS mean_ms,
--          round((disk_reads - lag(disk_reads) OVER (ORDER BY at))::numeric
--                / nullif(calls - lag(calls) OVER (ORDER BY at), 0))               AS reads_per_call
--   FROM public.audit_20260828_underpriced_board_cost ORDER BY at;
--
-- ⚠ The board query's own warmer calls are in the same statistics as user calls;
-- the counters cannot separate them. Read this as the cost of a board execution,
-- not as user-perceived latency.
--
-- CLEANUP -- NAMES THE EXACT RELATIONS. Do NOT wildcard `audit_20260828_*`:
-- several sessions write into the same date prefix, and destroying a sibling
-- session's revert path is silent and only discovered on a day something has
-- already gone wrong.
--   SELECT cron.unschedule('rpc-audit-underpriced-board-cost');
--   DROP FUNCTION IF EXISTS public.audit_20260828_sample_underpriced_board_cost();
--   DROP TABLE IF EXISTS public.audit_20260828_underpriced_board_cost;
-- (The function self-unschedules after 2026-08-30 regardless.)

CREATE TABLE IF NOT EXISTS public.audit_20260828_underpriced_board_cost (
  at         timestamptz PRIMARY KEY DEFAULT now(),
  calls      bigint NOT NULL,
  total_ms   bigint NOT NULL,
  disk_reads bigint NOT NULL
);
ALTER TABLE public.audit_20260828_underpriced_board_cost ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260828_underpriced_board_cost FROM anon, authenticated;

-- anon-exec decision: SECURITY DEFINER, revoked from public/anon/authenticated.
-- It reads extensions.pg_stat_statements, which anon must never reach.
CREATE OR REPLACE FUNCTION public.audit_20260828_sample_underpriced_board_cost()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_calls bigint; v_ms bigint; v_reads bigint;
BEGIN
  IF now() > timestamptz '2026-08-30 00:00:00+00' THEN
    PERFORM cron.unschedule('rpc-audit-underpriced-board-cost');
    RETURN;
  END IF;
  -- schema-qualified rather than widening this SECDEF function's search_path
  SELECT s.calls, round(s.total_exec_time)::bigint, s.shared_blks_read
    INTO v_calls, v_ms, v_reads
  FROM extensions.pg_stat_statements s WHERE s.queryid = 1829717808799315559;
  IF v_calls IS NULL THEN RETURN; END IF;  -- stats reset: skip, never write a false zero
  INSERT INTO public.audit_20260828_underpriced_board_cost (at, calls, total_ms, disk_reads)
  VALUES (now(), v_calls, v_ms, v_reads) ON CONFLICT (at) DO NOTHING;
END $fn$;
REVOKE ALL ON FUNCTION public.audit_20260828_sample_underpriced_board_cost() FROM public, anon, authenticated;

SELECT cron.schedule('rpc-audit-underpriced-board-cost', '*/10 * * * *',
  $$select public.audit_20260828_sample_underpriced_board_cost();$$);

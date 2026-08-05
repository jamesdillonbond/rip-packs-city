-- The fmv-recalc sweep can WEDGE mid-catalogue: runs keep firing, each one fails
-- (lock timeout / saturation) and rewrites the SAME cursor, so the catalogue stops
-- being repriced while every existing freshness arm stays green.
--
-- fmv_sweep_stall_pct_24h CANNOT see this. It measures the share of runs starting at
-- cursor_before='0' -- the 2026-08-03 "restart at page 0" class. A sweep wedged at an
-- interior offset never restarts at 0, so that arm read 4.3 = ok through the whole
-- 2026-08-05 incident (throughput ~3,000 eds/h -> 7-46 eds/h for 8h).
--
-- This view measures the thing that actually matters: how long since the cursor last
-- MOVED. An advance is a successful run whose cursor_after differs from cursor_before;
-- the end-of-catalogue wrap (cursor_after NULL, has_more=false) counts as an advance,
-- which IS DISTINCT FROM handles correctly.
--
-- Calibration over the retained 72h window (which INCLUDES the 08-05 incident):
--   293 advances, gap p50 0.20h, p95 0.55h, MAX 6.00h (= the incident).
-- Suggested breach_at 3h: 5.5x the healthy p95, and would have fired on 08-05.
-- Deliberately ABOVE the sibling fmv-recalc cron_silent arm (120 min), which detects
-- ABSENCE of runs; this detects runs that happen but make no progress.
--
-- Cost: index-served on pipeline_runs_pipeline_started_idx, 4 buffers / ~11ms, so it
-- is safe INLINE and needs no precompute row (unlike the fmv_snapshots-scanning arms).
--
-- NOTE: pipeline_runs retains only ~73h. If the sweep were wedged longer than the whole
-- retention window there would be no advancing run at all and hours_since_advance would
-- be NULL -- reported as 999 so absence BREACHES rather than reading as health.
CREATE OR REPLACE VIEW public.v_fmv_sweep_wedge AS
SELECT
  COALESCE(
    round((EXTRACT(epoch FROM now() - max(started_at)) / 3600.0)::numeric, 2),
    999
  ) AS hours_since_cursor_advance,
  max(started_at)                             AS last_advance_at,
  count(*) FILTER (WHERE started_at > now() - interval '24 hours') AS advances_24h
FROM public.pipeline_runs
WHERE pipeline = 'fmv-recalc'
  AND ok
  AND cursor_after IS DISTINCT FROM cursor_before;

ALTER VIEW public.v_fmv_sweep_wedge SET (security_invoker = on);

COMMENT ON VIEW public.v_fmv_sweep_wedge IS
'Hours since the fmv-recalc catalogue sweep cursor last ADVANCED. Complements fmv_sweep_stall_pct_24h, which is structurally blind to a mid-catalogue wedge (it only detects restart-at-page-0). Healthy p50 0.20h / p95 0.55h; the 2026-08-05 saturation incident peaked at 6.00h. Suggested breach_at 3. Index-served, 4 buffers / ~11ms -- safe inline, no precompute needed. 999 when no advancing run exists in the ~73h pipeline_runs retention window (absence must breach, not read as health). NOT yet wired into v_rpc_trust_health -- see docs/handoff-2026-08-05-fmv-sweep-wedge-incident.md.';

REVOKE ALL ON public.v_fmv_sweep_wedge FROM anon, authenticated;
GRANT SELECT ON public.v_fmv_sweep_wedge TO service_role;

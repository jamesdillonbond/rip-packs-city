-- 2026-08-05 · New trust arm: fmv_sweep_wedge_hours.
--
-- WHY: on 2026-08-05 the fmv-recalc sweep WEDGED at cursor offset 1500 for ~9h under
-- DB I/O saturation -- runs kept firing, each failed on lock timeout / chunk-fetch
-- error and rewrote the SAME cursor, so throughput fell ~3,000 editions/h -> 7-46/h.
-- fmv_sweep_stall_pct_24h read 4.3 = ok THROUGH THE ENTIRE INCIDENT, because it counts
-- only runs restarting at cursor_before='0' (the 2026-08-03 restart-at-page-0 class).
-- A sweep wedged at an INTERIOR offset never restarts at 0. The board stayed green
-- while the alert channel was actively paging fmv-recalc cron_silent, and the 08:07Z
-- overnight pass read the green board and recorded health as fine.
--
-- Uses the same guarded DO-block anchored replace as
-- audit_20260805_panini_capture_arm_catches_states_uncertainty: RAISE if the anchor is
-- missing, RAISE if the arm is already present, RAISE if no change was produced.
--
-- ⚠ CREATE OR REPLACE VIEW drops reloptions; security_invoker=on is re-set below.
--
-- REVERT: re-run this DO block with c_new/c_old swapped, or simply
--   DELETE the inserted arm by replacing it with '' via the same anchor technique.
DO $mig$
DECLARE
  v_def text; v_new text; v_anchor text; v_arm text;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  IF position('fmv_sweep_wedge_hours' in v_def) > 0 THEN
    RAISE EXCEPTION 'arm already present -- refusing to double-insert';
  END IF;

  v_anchor := 'SELECT ''fmv_sanity_flags''::text AS text,';

  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found: fmv_sanity_flags arm';
  END IF;

  v_arm :=
    'SELECT ''fmv_sweep_wedge_hours''::text AS text,
    ( SELECT w.hours_since_cursor_advance FROM public.v_fmv_sweep_wedge w) AS "coalesce",
    (3)::numeric AS "numeric",
    ''the fmv-recalc catalogue sweep WEDGED at an interior cursor offset -- runs keep firing but stop making progress, so the catalogue silently stops being repriced. Hours since the sweep cursor last ADVANCED (a successful run whose cursor_after differs from cursor_before; the end-of-catalogue wrap, cursor_after NULL with has_more=false, counts as an advance). THIS IS THE ARM fmv_sweep_stall_pct_24h STRUCTURALLY CANNOT BE: that one measures the share of runs starting at cursor_before=0, i.e. the 2026-08-03 restart-at-page-0 class, and a sweep stuck at an INTERIOR offset never restarts at 0 -- it read 4.3 = ok through the entire 2026-08-05 incident, in which throughput fell from about 3,000 editions/h to 7-46/h for eight hours while every per-collection freshness arm also stayed green (other writers -- cold-tail, thin-sales-guard, ask_only -- keep touching computed_at, which is why the *_fmv_stale_hours family cannot see a sweep outage either). Calibrated on the retained 72h window INCLUDING that incident: 293 advances, gap p50 0.20h, p95 0.55h, max 6.00h. breach_at 3 is 5.5x the healthy p95 and would have fired on 08-05. Deliberately ABOVE the sibling fmv-recalc cron_silent alert (120 min), which detects ABSENCE of runs; this detects runs that happen and achieve nothing. INLINE, not precomputed: index-served on pipeline_runs_pipeline_started_idx at 4 buffers / ~11ms, so it costs nothing and carries no precompute staleness. pipeline_runs retains only ~73h, so if the sweep were wedged longer than the whole retention window there would be no advancing run at all -- that reports 999 and BREACHES, because absence must never read as health.''::text AS text
UNION ALL
         ';

  v_new := replace(v_def, v_anchor, v_arm || v_anchor);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'no change produced -- refusing to replace the view';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;

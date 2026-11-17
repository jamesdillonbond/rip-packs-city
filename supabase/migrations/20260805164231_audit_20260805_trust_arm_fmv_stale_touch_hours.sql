-- 2026-08-05 · New trust arm: fmv_stale_touch_hours -- closes the Step 6 coverage gap.
--
-- THE GAP (Cowork, 2026-08-05): Step 6 of /api/fmv-recalc (the force_stale liveness
-- touch) keeps ~692 HIGH/MEDIUM editions with no in-window sales from ageing -- 579 Top
-- Shot + 113 All Day. NOTHING watches it. A per-collection *_fmv_stale_hours arm reads
-- max(computed_at) across the WHOLE collection, and the sweep writes TS and All Day
-- constantly, so those arms sit at 0.0-0.1h while their Step-6 cohort ages to 36h. If
-- Step 6 died tomorrow every existing arm would stay green. Confirmed by grep:
-- force_stale / step 6 / liveness touch appear in v_rpc_trust_health ONLY inside
-- ufc_fmv_stale_hours's catches text, and not at all in get_pipeline_alerts().
--
-- WHY THIS SHAPE AND NOT THE COHORT-AGE ARM. Cowork proposed measuring max age of the
-- cohort itself and could not calibrate it under a 60s client budget. Measured here via
-- a cron_heavy one-shot: that query takes 379s and ~930k buffers. Results, for the
-- record: Top Shot cohort 579 (min 12.6h / p50 16.7h / max 36.2h), All Day cohort 113
-- (12.6 / 16.7 / 36.1) -- so TS is NOT worse than All Day, and both sit at ~36h against
-- Step 6's own 24h gate. 379s every 6h is a heavy addition to a precompute that already
-- contributes to the daily 12:58 load peak, for a cohort whose staleness has no
-- user-facing consequence (Step 6 only touches editions with NO recent sales, so the
-- underlying VALUE is not changing -- only its computed_at).
--
-- ⚠ THE CHEAP PROXY IS INVALID -- measured, not assumed. Substituting the stored
-- fmv_snapshots.sales_count_30d for the live 30-day sales anti-join collapses the
-- cohort from 692 to 22, because sales_count_30d is the count AT COMPUTE TIME and
-- fossilises as sales age out of the window (the same self-contradiction class the
-- 08-03 fmv_snapshots_zero_stale_sales_count trigger was built for). Do not "optimise"
-- the cohort query that way.
--
-- WHAT THIS ARM DOES INSTEAD: watch the writer's OWN REPORTED OUTPUT. /api/fmv-recalc
-- already records extra->>'stale_touch' (rows touched) on every terminal run, so
-- "hours since a run last reported stale_touch > 0" is an index-served read on
-- pipeline_runs -- a few buffers, safe INLINE, versus 379s.
--
-- CALIBRATION (the ~73h pipeline_runs retention window, which INCLUDES the 08-05
-- saturation incident): 22 touching runs, 1,388 rows touched, i.e. roughly one touch
-- every 3.3h; current gap 14.9h, elevated because the incident ate force_stale runs.
-- breach_at 36 = 1.5x Step 6's own 24h gate and ~2.4x today's incident-elevated gap,
-- so an ordinary bad day cannot page but a dead Step 6 surfaces inside 36h.
-- ⚠ Only ~73h of history exists to calibrate against (pipeline_runs retention), so
-- treat 36 as a first cut and revisit once pipeline_runs_daily has more depth.
--
-- ⚠ KNOWN COVERAGE LIMIT, stated rather than hidden: this is a GLOBAL signal. If Step 6
-- kept touching Top Shot but stopped for All Day, this arm would stay green. The
-- cohort-age arm would catch that; it costs 379s. That trade is deliberate.
--
-- 999 when no touching run exists in the retention window -- absence must BREACH.
--
-- ⚠ CREATE OR REPLACE VIEW drops reloptions; security_invoker=on is re-set below.
DO $mig$
DECLARE
  v_def text; v_new text; v_anchor text; v_arm text;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  IF position('fmv_stale_touch_hours' in v_def) > 0 THEN
    RAISE EXCEPTION 'arm already present -- refusing to double-insert';
  END IF;

  v_anchor := 'SELECT ''fmv_sanity_flags''::text AS text,';
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found: fmv_sanity_flags arm';
  END IF;

  v_arm :=
    'SELECT ''fmv_stale_touch_hours''::text AS text,
    COALESCE(( SELECT round((EXTRACT(epoch FROM now() - max(pr.started_at)) / 3600.0)::numeric, 1)
                 FROM public.pipeline_runs pr
                WHERE pr.pipeline = ''fmv-recalc''
                  AND pr.extra ? ''stale_touch''
                  AND (pr.extra ->> ''stale_touch'')::int > 0), 999) AS "coalesce",
    (36)::numeric AS "numeric",
    ''Step 6 of /api/fmv-recalc -- the force_stale LIVENESS TOUCH -- stopped touching anything. Hours since a fmv-recalc run last reported extra->>stale_touch > 0. THIS IS THE ONLY ARM COVERING STEP 6: it keeps about 692 HIGH/MEDIUM editions with no in-window sales from ageing (579 Top Shot + 113 All Day), and every per-collection *_fmv_stale_hours arm is structurally blind to it, because those read max(computed_at) across the WHOLE collection and the sweep writes TS and All Day constantly -- measured 2026-08-05, those arms sat at 0.0-0.1h while their Step-6 cohort aged to 36h. If Step 6 died every other arm would stay green. WHY THIS SHAPE: the direct cohort-age measurement costs 379s and about 930k buffers (measured via a cron_heavy one-shot, since it exceeds a 60s client budget: TS cohort 579 at min 12.6 / p50 16.7 / max 36.2h, All Day 113 at 12.6 / 16.7 / 36.1h -- TS is NOT worse than All Day). That is too expensive to run every 6h for a cohort whose staleness has no user-facing effect, since Step 6 only touches editions with NO recent sales so the VALUE is unchanged and only computed_at moves. Watching the writer own reported output instead is index-served and safe inline. WARNING, MEASURED NOT ASSUMED: substituting the stored fmv_snapshots.sales_count_30d for the live 30-day sales anti-join collapses the cohort 692 to 22, because that column is the count AT COMPUTE TIME and fossilises as sales age out of the window -- the same self-contradiction class the 2026-08-03 fmv_snapshots_zero_stale_sales_count trigger exists for. Do NOT optimise the cohort query that way. CALIBRATION over the roughly 73h pipeline_runs retention window, which INCLUDES the 2026-08-05 saturation incident: 22 touching runs, 1,388 rows touched, about one touch every 3.3h, current gap 14.9h elevated because the incident ate force_stale runs. breach_at 36 is 1.5x Step 6 own 24h gate and about 2.4x that incident-elevated gap, so an ordinary bad day cannot page but a dead Step 6 surfaces within 36h; only ~73h of history exists to calibrate on, so revisit once pipeline_runs_daily has depth. KNOWN LIMIT, stated not hidden: this is a GLOBAL signal -- if Step 6 kept touching Top Shot but stopped for All Day this arm stays green; the 379s cohort arm would catch that, and that trade is deliberate. Reports 999 when no touching run exists in the retention window, because absence must BREACH rather than read as health.''::text AS text
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

-- audit_20260904_watchlist_cron_silent_grace_for_new_rows_and_window_ge_threshold
-- Applied to prod via MCP apply_migration 2026-09-04 04:16Z (version 20260904041635).
--
-- FINDING (2026-09-04 04:xxZ health sweep): `topshot-circulation-onchain` was inserted into
-- pipeline_cadence_watchlist at 03:19:44Z (max_silent_minutes 4320) and was ALREADY firing
-- `cron_silent` medium ("Last run > 24h ago — expected within 4320 min") in get_pipeline_alerts()
-- and `no_marker` in detect_stalled_pipelines() minutes later, before its first scheduled tick.
-- Two defects in the arms:
--   (1) `last_run IS NULL` alerts immediately — no grace for a row younger than its own threshold.
--       The table has had `created_at DEFAULT now()` and NO arm read it.
--   (2) get_pipeline_alerts_core's lateral is hard-clamped to 24 h, so any threshold > 1440 min is
--       silently 1440: a run 30 h ago reads as NULL and "Last run > 24h ago" even though 4320 min
--       have not elapsed. Same text also lied about the window.
-- FIX: both arms require `created_at < now() - max_silent_minutes` before a never-run row can alert;
-- the lateral window becomes GREATEST(24 h, threshold); the fallback text names the real window.
-- A never-run row STILL alerts once it is older than its own threshold (the guard is a delay, not
-- a suppression). Shape: guarded splices on the live definitions (ACL/SECDEF/search_path carried).
-- anon-exec: unchanged (get_pipeline_alerts_core, detect_stalled_pipelines) — both stay postgres/service_role only.
--
-- REVERT: the same three DO blocks with v_old/v_new swapped.

-- 1/3 get_pipeline_alerts_core — lateral window + created_at grace
DO $mig$
DECLARE v_def text; v_def2 text; v_hits int;
  v_old text := $old$      WHERE pr.pipeline = wl.pipeline
        AND pr.started_at > NOW() - INTERVAL '24 hours'
    ) max_run ON true
    WHERE wl.is_active = true
      AND wl.pipeline NOT IN (SELECT pipeline FROM active_suppressions)
      AND (max_run.last_at IS NULL$old$;
  v_new text := $new$      WHERE pr.pipeline = wl.pipeline
        -- 2026-09-04: the window must cover the threshold, or thresholds > 1440 min clamp to 24 h
        AND pr.started_at > NOW() - GREATEST(INTERVAL '24 hours', wl.max_silent_minutes * INTERVAL '1 minute')
    ) max_run ON true
    WHERE wl.is_active = true
      AND wl.pipeline NOT IN (SELECT pipeline FROM active_suppressions)
      -- 2026-09-04: a row younger than its own threshold cannot be "silent" yet (grace for new pipelines)
      AND wl.created_at < NOW() - (wl.max_silent_minutes * INTERVAL '1 minute')
      AND (max_run.last_at IS NULL$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_pipeline_alerts_core';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_pipeline_alerts_core not found'; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'core/window: expected 1 anchor occurrence, found %', v_hits; END IF;
  v_def2 := replace(v_def, v_old, v_new);
  IF v_def2 = v_def THEN RAISE EXCEPTION 'core/window: replacement was a no-op'; END IF;
  EXECUTE v_def2;
END $mig$;

-- 2/3 get_pipeline_alerts_core — the fallback detail text names the real window
DO $mig$
DECLARE v_def text; v_def2 text; v_hits int;
  v_old text := $old$COALESCE(age(now(), max_run.last_at)::text, '> 24h ago') ||$old$;
  v_new text := $new$COALESCE(age(now(), max_run.last_at)::text, '> ' || GREATEST(1440, wl.max_silent_minutes)::text || ' min ago') ||$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_pipeline_alerts_core';
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'core/text: expected 1 anchor occurrence, found %', v_hits; END IF;
  v_def2 := replace(v_def, v_old, v_new);
  IF v_def2 = v_def THEN RAISE EXCEPTION 'core/text: replacement was a no-op'; END IF;
  EXECUTE v_def2;
END $mig$;

-- 3/3 detect_stalled_pipelines — created_at grace
DO $mig$
DECLARE v_def text; v_def2 text; v_hits int;
  v_old text := $old$  WHERE w.is_active
    AND (lr.last_run IS NULL OR (extract(epoch from (now()-lr.last_run))/60) > w.max_silent_minutes);$old$;
  v_new text := $new$  WHERE w.is_active
    -- 2026-09-04: a row younger than its own threshold cannot be stalled yet (grace for new pipelines)
    AND w.created_at < now() - (w.max_silent_minutes * interval '1 minute')
    AND (lr.last_run IS NULL OR (extract(epoch from (now()-lr.last_run))/60) > w.max_silent_minutes);$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='detect_stalled_pipelines';
  IF v_def IS NULL THEN RAISE EXCEPTION 'detect_stalled_pipelines not found'; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'detect: expected 1 anchor occurrence, found %', v_hits; END IF;
  v_def2 := replace(v_def, v_old, v_new);
  IF v_def2 = v_def THEN RAISE EXCEPTION 'detect: replacement was a no-op'; END IF;
  EXECUTE v_def2;
END $mig$;

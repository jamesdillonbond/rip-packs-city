-- audit_20261112_candy_editions_ingest_failure_rate_bounded_suppression
--
-- 2026-11-12 ~8:50 AM PT (Claude Code cloud; Trevor: "Keep going and try to fix all of these").
--
-- `candy-editions-ingest` failure_rate MEDIUM ("2/6 runs failed, wallet_moments_cache lock timeout") pools two
-- 01:10Z ticks (5:10 PM PT 11-09 and 11-10, each 1 rejected write of ~61k) from BEFORE the populate-lock fix
-- 20261111172832 (applied 9:28 AM PT 11-11). Since it: 2 runs, both ok with 61,151 rows written — incl. the
-- 01:10Z slot that used to collide. The reading corrects itself at 00:00 UTC 11-13 (4 PM PT 11-12), when 11-10
-- leaves the 3-UTC-day window and fewer than the arm's 5 runs remain; this row expires at EXACTLY that instant,
-- BEFORE tonight's 01:10Z tick, so it cannot hide a recurrence of the collision.
--
-- REVERT: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'candy-editions-ingest';

DO $premise$
DECLARE v_fail_since int; v_runs_since int;
BEGIN
  SELECT count(*) FILTER (WHERE ok IS NOT TRUE), count(*) INTO v_fail_since, v_runs_since FROM public.pipeline_runs
   WHERE pipeline = 'candy-editions-ingest' AND started_at >= '2026-11-11T17:28:32Z';
  IF v_fail_since > 0 OR v_runs_since < 2 THEN
    RAISE EXCEPTION 'premise false: % failed of % candy-editions-ingest runs since the lock fix', v_fail_since, v_runs_since;
  END IF;
END
$premise$;

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at) VALUES (
  'candy-editions-ingest',
  'Pooled across a FIX, not a live failure. Both ok=false rows are 01:10Z ticks (5:10 PM PT 11-09, 11-10; 1 rejected wmc write of ~61k, lock timeout) from BEFORE the populate-lock fix 20261111172832 (9:28 AM PT 11-11). PREDICATE (re-check it): zero ok=false candy-editions-ingest rows since 2026-11-11T17:28:32Z. VERIFIED 2026-11-12 ~8:50 AM PT: 2 runs since, both ok, 61,151 rows each, incl. the 01:10Z slot. WHAT IS NOT LOST: expires 2026-11-13 00:00 UTC (4 PM PT 11-12) — the instant the reading clears itself (11-10 leaves the window; < 5 runs remain) and BEFORE tonight''s 01:10Z tick, so a recurrence of the collision still pages. Revert: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''candy-editions-ingest'';',
  now(),
  '2026-11-13T00:00:00Z'
);

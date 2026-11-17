-- audit_20261112_continuation_failure_rate_bounded_suppression
--
-- 2026-11-12 ~8:45 AM PT (Claude Code cloud; Trevor: "Keep going and try to fix all of these. These errors
-- have gone on long enough").
--
-- The `wallet-backfill-continuation` failure_rate alert (HIGH, "8/9 runs failed") pools rows from BEFORE the
-- 11-11 fix `b87f40e9` (deployed ~7:22 PM PT 11-11): a continuation Vercel refuses with HTTP 508 is now
-- QUEUED and the row reads ok=true with extra.deferred_to='resume_queue'. Since the deploy: 2 runs, both
-- ok=true deferrals (11:01 PM PT 11-11, 6:33 AM PT 11-12), both dispatched by /api/cron/wallet-backfill-resume
-- (picked 1 / dispatched 1, requeued 0), queue empty. The arm's own escape hatch — `cleared_by_streak`, 20 ok
-- runs since the last failure (20260923231922) — cannot fire on a demand-driven lane that runs ~2×/day, so
-- the alert would sit HIGH until the last pre-fix row (2:12 PM PT 11-11) leaves the 3-UTC-day window at
-- 00:00 UTC 11-14 (4 PM PT 11-13). This row expires at EXACTLY that instant (the 20260919210201 lesson: a
-- suppression must not outlive the day the reading corrects itself).
--
-- REVERT: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'wallet-backfill-continuation';

DO $premise$
DECLARE v_fail_since int; v_resume_fail int; v_queue int;
BEGIN
  -- no ok=false continuation row since the fix deployed
  SELECT count(*) INTO v_fail_since FROM public.pipeline_runs
   WHERE pipeline = 'wallet-backfill-continuation' AND started_at >= '2026-11-12T03:22:00Z' AND ok IS NOT TRUE;
  IF v_fail_since > 0 THEN
    RAISE EXCEPTION 'premise false: % failed continuation runs since the fix deployed', v_fail_since;
  END IF;
  -- the resume lane (NOT suppressed) is healthy, so the deferred path works
  SELECT count(*) INTO v_resume_fail FROM public.pipeline_runs
   WHERE pipeline = 'wallet-backfill-resume' AND started_at > now() - interval '24 hours' AND ok IS NOT TRUE;
  IF v_resume_fail > 0 THEN
    RAISE EXCEPTION 'premise false: % failed resume runs in 24h', v_resume_fail;
  END IF;
  SELECT count(*) INTO v_queue FROM public.wallet_backfill_resume_queue;
  IF v_queue > 3 THEN
    RAISE EXCEPTION 'premise false: % continuations waiting in the resume queue', v_queue;
  END IF;
END
$premise$;

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at) VALUES (
  'wallet-backfill-continuation',
  'Pooled across a FIX, not a live failure. All ok=false rows pre-date b87f40e9 (deployed ~7:22 PM PT 11-11): a continuation Vercel refuses with HTTP 508 is now queued and logged ok=true (extra.deferred_to=resume_queue). PREDICATE THAT JUSTIFIES THIS ROW (re-check it, do not trust this text): (1) zero ok=false wallet-backfill-continuation rows since 2026-11-12T03:22Z; (2) zero ok=false wallet-backfill-resume rows in 24h; (3) wallet_backfill_resume_queue near-empty. VERIFIED 2026-11-12 ~8:45 AM PT: 2 post-fix runs, both deferred ok=true and dispatched by the resume cron, queue empty. WHY NOT THE STREAK SPLIT: cleared_by_streak needs 20 ok runs since the last failure; this demand-driven lane runs ~2x/day. WHAT IS NOT LOST: wallet-backfill-resume is NOT suppressed and marks its own run ok=false on any requeue or drop, so a continuation that can no longer be dispatched still pages. RESIDUAL, accepted: a not-queued 508 (queue write failure) on this lane is hidden until expiry. EXPIRES 2026-11-14 00:00 UTC (4 PM PT 11-13) — the instant the last pre-fix row leaves the 3-UTC-day window, so the reading then corrects itself. Revert: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''wallet-backfill-continuation'';',
  now(),
  '2026-11-14T00:00:00Z'
);

-- audit_20260830: two more pipelines in the dead-host class, missed by the
-- 03:5xZ pause (20260830034312) and named by the 13:0xZ cloud pass.
--
-- get_pipeline_alerts() at 15:55Z still lists, as failure_rate:
--   topshot-badge-catalog       5/5 failed  -- "Top Shot GraphQL failed with 530"
--   topshot-deal-floor-serials 22/59 failed -- "resolved 0 of 10 deal editions;
--                                              10 fetch errors; first: ... 530"
-- Both call public-api.nbatopshot.com, which has answered 530/1033 since
-- 08-28 ~17Z (probed again this pass: 530). The same reason string and the
-- same 2026-09-13 expiry as the six rows already in place, so the class's
-- exit condition -- host answers non-5xx twice -> DELETE ... WHERE reason
-- LIKE 'dead host 2026-08-30%' -- covers all eight. Schedules are NOT
-- touched here: topshot-deal-floor-serials is a cron-job.org entry (hourly
-- :37) that can only be paused from the console, and topshot-badge-catalog
-- fires at 08:31Z and 13:58Z from GHA; both are cheap HTTP fails (the
-- deal-floor one also reads the deal board first, which cost it a lock
-- timeout at 08:37Z and a statement timeout at 13:37Z under the storms).
-- Pausing the cron-job.org entry is a console action for the next pass or
-- Trevor.
--
-- anon-exec: none (no function created or replaced).
-- REVERT: DELETE FROM public.pipeline_alert_suppression WHERE pipeline IN ('topshot-badge-catalog','topshot-deal-floor-serials') AND reason LIKE 'dead host 2026-08-30%';

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, expires_at)
SELECT p, 'dead host 2026-08-30: public-api.nbatopshot.com 530/1033 since 08-28 ~17Z; failure_rate can only report the outage. Schedules paused (cron-job.org 7526594/7617630/7658302, pg_cron 16) or breaker-guarded (offers-sweep). Exit + revert in migration 20260830 dead_host_pipelines_paused.', '2026-09-13 00:00:00+00'
FROM unnest(ARRAY['topshot-badge-catalog','topshot-deal-floor-serials']) AS u(p)
WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_alert_suppression s WHERE s.pipeline = u.p AND (s.expires_at IS NULL OR s.expires_at > now()));

DO $$
BEGIN
  IF (SELECT count(*) FROM public.pipeline_alert_suppression WHERE reason LIKE 'dead host 2026-08-30%' AND (expires_at IS NULL OR expires_at > now())) <> 8 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 8 live dead-host suppression rows, found %',
      (SELECT count(*) FROM public.pipeline_alert_suppression WHERE reason LIKE 'dead host 2026-08-30%' AND (expires_at IS NULL OR expires_at > now()));
  END IF;
END $$;

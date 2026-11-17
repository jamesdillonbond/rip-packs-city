-- audit_20260830_dead_host_pipelines_paused_on_cron_job_org_bounded_suppressions_and_arms_off
--
-- Trevor 2026-08-29 (late PT): "address these from sentinel" — the 5-active Pipeline Alert:
--   offers-sweep 93/141 · topshot-badge-set-backfill 5/8 · topshot-fmv-populate 6/8 ·
--   topshot-moments-hydrator 172/276 · topshot-pack-pool-backfill 460/561 — every last error is
--   `public-api.nbatopshot.com` 530/1033 (dead since 08-28 ~17Z, see inbox 2026-08-29T1630Z).
-- Last 24 h, all eight dead-host pipelines wrote ZERO rows: compute-topshot-pack-ev 416 runs x 15 s,
-- pack-pool-backfill 262 x 62 s (paused 02:18Z), moments-hydrator 137 x 3 s, offers-sweep 70 x 44 s.
--
-- DONE ON cron-job.org (console, server-confirmed "Inactive"), all reversible by re-enabling the entry:
--   7526594 RPC Compute Topshot Pack EV      (edge fn, every 6 min)
--   7617630 RPC Topshot Moments Hydrator     (worker, every 10 min)
--   7658302 RPC TopShot FMV Populate         (Vercel route, 4x/day)
-- NOT paused: offers-sweep (the concurrent session shipped an upstream circuit breaker in c8ac905
-- that skips cheaply on the Cloudflare-origin-down signature and auto-resumes), badge-sync.yml
-- (its GHA also chains the AllDay + Golazos seeds, and the TS leg fails in ~5 s at the first call),
-- wallet-username-resolver / topshot-deal-floor-serials (partially succeeding).
--
-- HERE:
--   1. pipeline_alert_suppression rows, BOUNDED to 2026-09-13, for the six failure_rate arms that
--      can only report the dead host. The cadence arms stay on for the un-paused ones, so a total
--      stop is still caught.
--   2. pipeline_cadence_watchlist.is_active = false for the THREE paused schedules (a 30-min arm
--      on a paused job would page on the silence) with the exit condition in the note.
--
-- EXIT (one condition for the whole class, also in the pass prompt): the host answers non-5xx twice
-- to `curl -s -o /dev/null -w "%{http_code}" -X POST https://public-api.nbatopshot.com/graphql -d '{"query":"{__typename}"}'`
-- -> re-enable the three cron-job.org entries + `cron.alter_job(16, active => true)`, set the three
-- arms is_active = true, DELETE the six suppression rows. Or: the functions are ported to Studio.
--
-- REVERT: DELETE FROM public.pipeline_alert_suppression WHERE reason LIKE 'dead host 2026-08-30%';
--         UPDATE public.pipeline_cadence_watchlist SET is_active = true WHERE pipeline IN (...three...);

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, expires_at)
SELECT p, 'dead host 2026-08-30: public-api.nbatopshot.com 530/1033 since 08-28 ~17Z; failure_rate can only report the outage. Schedules paused (cron-job.org 7526594/7617630/7658302, pg_cron 16) or breaker-guarded (offers-sweep). Exit + revert in migration 20260830 dead_host_pipelines_paused.', '2026-09-13 00:00:00+00'
FROM unnest(ARRAY['offers-sweep','topshot-badge-set-backfill','topshot-fmv-populate','topshot-moments-hydrator','topshot-pack-pool-backfill','compute-topshot-pack-ev']) AS u(p)
WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_alert_suppression s WHERE s.pipeline = u.p AND (s.expires_at IS NULL OR s.expires_at > now()));

UPDATE public.pipeline_cadence_watchlist
SET is_active = false,
    notes = notes || E'\n\n⏸ PAUSED 2026-08-30 03:5xZ (Trevor: "address these from sentinel"): the schedule is INACTIVE on cron-job.org because public-api.nbatopshot.com has been 530/1033 since 08-28 ~17Z and this pipeline wrote 0 rows in 24 h. This arm is off so it does not page on the intentional silence. EXIT: host answers non-5xx twice -> re-enable the cron-job.org entry and set is_active = true (migration 20260830 dead_host_pipelines_paused).'
WHERE pipeline IN ('compute-topshot-pack-ev','topshot-moments-hydrator','topshot-fmv-populate') AND is_active;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.pipeline_alert_suppression WHERE reason LIKE 'dead host 2026-08-30%') <> 6 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 6 suppression rows';
  END IF;
  IF (SELECT count(*) FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('compute-topshot-pack-ev','topshot-moments-hydrator','topshot-fmv-populate') AND NOT is_active) <> 3 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 3 arms off';
  END IF;
END $$;

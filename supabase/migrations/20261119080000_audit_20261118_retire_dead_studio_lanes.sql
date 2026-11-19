-- audit_20261118_retire_dead_studio_lanes
--
-- 2026-11-18 (PT, ~10:35 PM; Claude Code cloud; Trevor: "Retire what makes sense") -- #218.
-- Dapper's Studio GraphQL has answered HTTP 530 since 11-17 4:23 PM PT (its pack index froze 10-29).
-- Every lane below fails on every tick, writes nothing, and keeps ~10 medium rows on the alert board.
-- Each is either REPLACED tonight or has NO Atlas equivalent and is not worth one:
--
--   rpc-topshot-pack-sales-backfill  (backfill-topshot-pack-sales)  REPLACED: run_atlas_pack_sales_lane (nba)
--   rpc-allday-pack-sales-backfill   (backfill-allday-pack-sales)   REPLACED: run_atlas_pack_sales_lane (nfl)
--   rpc-golazos-pack-sales-backfill  (backfill-golazos-pack-sales)  no source: Atlas has 0 Golazos pack sales
--   rpc-pinnacle-pack-opens-ingest   (ingest-pinnacle-pack-opens)   REPLACED since 11-08: run_pinnacle_chain_opens_lane
--   rpc-golazos-pack-opens-ingest    (ingest-golazos-pack-opens)    no source: no public Atlas opens method; ~5 opens/month
--   rpc-allday-dist-opened-backfill  (backfill-allday-dist-opened)  no source: Atlas has opened counts per OWNER only
--   rpc-allday-dist-opened-expiry    (expire_allday_dist_opened_drifted) pointless without the hydrator above:
--       it NULLs drifted counts for the hydrator to refill, then restores the pre-images when it does not.
--       Paused, allday_pack_supply.opened_count simply stays at its last real value (never a fabricated 0).
--
-- HOW (all reversible, nothing deleted):
--   * cron.alter_job(active := false) -- the job keeps its command (and its gate key), so re-enabling is
--     one call; check_edge_lane_observability() already skips inactive jobs.
--   * pipeline_cadence_watchlist rows for those pipelines -> is_active = false (old rows backed up), so a
--     stopped lane does not read as a SILENT one.
--   * pipeline_alert_suppression for the 3-day failure-rate window those lanes already filled, EXPIRING
--     2026-11-22 (a suppression is a claim; it is gated on its own age).
--   * the replacement, atlas-pack-sales-ingest (every minute), goes ON the watchlist: 15 min silent.
-- NOT here: seed-topshot-pack-distributions is not scheduled from pg_cron, Vercel or GitHub Actions (an
-- external scheduler, cron-job.org) -- disable it there; discovery is covered by the Atlas pack book.
--
-- REVERT:
--   SELECT cron.alter_job(job_id := j.jobid, active := true) FROM cron.job j WHERE j.jobname IN (<the 7 above>);
--   UPDATE public.pipeline_cadence_watchlist w SET is_active = b.is_active, notes = b.notes
--     FROM public.audit_20261118_retired_studio_lanes_watchlist_backup b WHERE w.pipeline = b.pipeline;
--   DELETE FROM public.pipeline_alert_suppression WHERE reason LIKE 'RETIRED STUDIO LANE (2026-11-18)%';
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'atlas-pack-sales-ingest';

CREATE TABLE IF NOT EXISTS public.audit_20261118_retired_studio_lanes_watchlist_backup AS
SELECT now() AS backed_up_at, w.* FROM public.pipeline_cadence_watchlist w
 WHERE w.pipeline IN ('topshot-pack-sales-ingest', 'allday-pack-sales-ingest', 'golazos-pack-sales-ingest',
                      'golazos-pack-opens-ingest', 'pinnacle-pack-opens-ingest', 'allday-dist-opened-expiry');
ALTER TABLE public.audit_20261118_retired_studio_lanes_watchlist_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20261118_retired_studio_lanes_watchlist_backup FROM PUBLIC, anon, authenticated;

SELECT cron.alter_job(job_id := j.jobid, active := false)
  FROM cron.job j
 WHERE j.jobname IN ('rpc-topshot-pack-sales-backfill', 'rpc-allday-pack-sales-backfill', 'rpc-golazos-pack-sales-backfill',
                     'rpc-pinnacle-pack-opens-ingest', 'rpc-golazos-pack-opens-ingest',
                     'rpc-allday-dist-opened-backfill', 'rpc-allday-dist-opened-expiry');

UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = coalesce(notes, '') || ' | RETIRED 2026-11-18 (#218): Studio 530; pg_cron job paused by 20261119080000.'
 WHERE pipeline IN ('topshot-pack-sales-ingest', 'allday-pack-sales-ingest', 'golazos-pack-sales-ingest',
                    'golazos-pack-opens-ingest', 'pinnacle-pack-opens-ingest', 'allday-dist-opened-expiry');

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, expires_at)
SELECT p, 'RETIRED STUDIO LANE (2026-11-18), not a failure to act on: its pg_cron job is paused '
          || '(20261119080000); the failures on the board are the 3-day window it filled before. #218.',
       '2026-11-22 08:00:00+00'::timestamptz
  FROM unnest(ARRAY['topshot-pack-sales-ingest', 'allday-pack-sales-ingest', 'golazos-pack-sales-ingest',
                    'golazos-pack-opens-ingest', 'pinnacle-pack-opens-ingest', 'allday-dist-opened-expiry']) AS p
ON CONFLICT DO NOTHING;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('atlas-pack-sales-ingest', 15, 'medium',
        '2026-11-18 (#218): Top Shot + All Day pack sales from Atlas (run_atlas_pack_sales_lane, pg_cron rpc-atlas-pack-sales, every minute). Replaces the paused Studio walkers.',
        true)
ON CONFLICT (pipeline) DO NOTHING;

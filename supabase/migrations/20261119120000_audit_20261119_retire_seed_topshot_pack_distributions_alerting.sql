-- audit_20261119_retire_seed_topshot_pack_distributions_alerting
--
-- 2026-11-19 (PT, morning by DB clock; Claude Code cloud; Trevor: "Keep going and make your own decisions") -- #218.
-- The edge function seed-topshot-pack-distributions is now a 410 tombstone (same commit set; source archived in
-- supabase/retired-functions/). Its caller is an external cron-job.org entry this session cannot reach, so the
-- function -- not the scheduler -- is where it stops. A tombstone writes no pipeline_runs row, so its cadence
-- watch would read SILENT: deactivated here, like the seven Studio lanes paused 11-18 (20261119080000), and its
-- already-filled 3-day failure window is suppressed until 2026-11-22.
--
-- REVERT:
--   UPDATE public.pipeline_cadence_watchlist w SET is_active = b.is_active, notes = b.notes
--     FROM public.audit_20261119_retired_seed_topshot_watchlist_backup b WHERE w.pipeline = b.pipeline;
--   DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'seed-topshot-pack-distributions'
--     AND reason LIKE 'RETIRED (2026-11-19)%';

CREATE TABLE IF NOT EXISTS public.audit_20261119_retired_seed_topshot_watchlist_backup AS
SELECT now() AS backed_up_at, w.* FROM public.pipeline_cadence_watchlist w WHERE w.pipeline = 'seed-topshot-pack-distributions';
ALTER TABLE public.audit_20261119_retired_seed_topshot_watchlist_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20261119_retired_seed_topshot_watchlist_backup FROM PUBLIC, anon, authenticated;

UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = coalesce(notes, '') || ' | RETIRED 2026-11-19 (#218): edge function is a 410 tombstone; Atlas pack book seeds pack_distributions.'
 WHERE pipeline = 'seed-topshot-pack-distributions';

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, expires_at)
VALUES ('seed-topshot-pack-distributions',
        'RETIRED (2026-11-19), not a failure to act on: the edge function is a 410 tombstone (#218, Studio 530); '
        || 'the failures on the board are the 3-day window it filled before. Remove its cron-job.org entry.',
        '2026-11-22 08:00:00+00'::timestamptz)
ON CONFLICT (pipeline) DO NOTHING;

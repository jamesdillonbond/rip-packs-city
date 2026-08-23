-- Remove the parallel rollup I built earlier today before discovering that
-- `series_detail_rollup` + `refresh_series_detail_rollup()` + cron jobid 357
-- already existed and were healthy. Two rollups of the same numbers is a
-- divergence waiting to happen, and the older one covers Pinnacle as well.
--
-- Nothing reads these: get_series_detail was re-pointed at series_detail_rollup
-- in audit_20260823_get_series_detail_reads_existing_series_detail_rollup, and
-- no cron job was ever scheduled against refresh_series_stats_rollup.
--
-- The single pipeline_runs row it wrote is removed too, so the retired pipeline
-- name cannot surface in pipeline_runs_daily or a silence monitor as a
-- pipeline that "stopped reporting".
DROP FUNCTION IF EXISTS public.refresh_series_stats_rollup();
DROP TABLE IF EXISTS public.series_stats_rollup;
DELETE FROM public.pipeline_runs WHERE pipeline = 'refresh-series-stats-rollup';
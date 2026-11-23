-- audit_20261123_watchlist_paused_topshot_buyer_backfill_historical
--
-- 2026-11-23 ~2:10 PM PT (Claude Code cloud; Trevor: "Keep going"). Trevor paused cron-job.org job 7866110
-- (topshot-buyer-backfill-historical) ~7:45 AM PT 11-23 (Cowork, inbox 2026-11-23T1545Z item 5: it had re-found the
-- same undecodable decode_404 / spork_floor row on every run since 08-28, 0 written). Its pipeline_cadence_watchlist
-- row stayed active, so detect_stalled_pipelines() reports it as a breach (385 min silent vs 183 at 1:42 PM PT) and
-- rpc_gha_schedule_watchdog prints "1 cadence lane(s) breaching" — a deliberate pause read as a stall.
-- A paused lane is not watched: is_active = false, with the reason in notes. Last run 15:42Z (7:42 AM PT).
--
-- REVERT (when the lane is un-paused on cron-job.org):
--   UPDATE public.pipeline_cadence_watchlist SET is_active = true,
--          notes = regexp_replace(notes, ' \| PAUSED 2026-11-23.*$', '')
--    WHERE pipeline = 'topshot-buyer-backfill-historical';

DO $$
DECLARE v_n int;
BEGIN
  UPDATE public.pipeline_cadence_watchlist
     SET is_active = false,
         notes = notes || ' | PAUSED 2026-11-23 ~7:45 AM PT by Trevor on cron-job.org (job 7866110): re-found the same undecodable row every run since 08-28, 0 written. Re-activate this row if the lane is un-paused.'
   WHERE pipeline = 'topshot-buyer-backfill-historical' AND is_active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 active watchlist row for topshot-buyer-backfill-historical, updated %', v_n; END IF;
END $$;

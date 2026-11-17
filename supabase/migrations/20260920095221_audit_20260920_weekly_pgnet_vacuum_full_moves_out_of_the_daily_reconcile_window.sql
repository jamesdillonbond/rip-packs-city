-- Follow-up to 20260920020934 (#75: weekly `VACUUM FULL net._http_response`, jobid 542,
-- `43 9 * * 0`, as postgres, 120 s default). Its first scheduled run, Sunday 2026-09-20 09:43Z
-- (2:43 AM PT), landed INSIDE the daily edition_fmv_current full reconcile's window (jobid 539,
-- `36 9 * * *`, which was reading fmv_snapshots cold at ~3 MB/s until it died at 600 s) and took
-- 117 s of its 120 s budget — 7.7 s on the quiet evening box the evening before — while holding
-- ACCESS EXCLUSIVE on net._http_response; pack-nft-identity, atlas-editions-drain,
-- atlas-market-drain, topshot-moment-hydrate and atlas-listing-verify all sat on
-- `Lock: relation` for two minutes. Both jobs are mine from the same evening; I put them seven
-- minutes apart on the same Sunday morning.
--
-- Moved to `16 9 * * 0` (2:16 AM PT Sunday): the :16–:18 band is the hour's coverage trough by
-- the 4-day measure in 20260920064646, twenty minutes before the reconcile starts, and after
-- the Sunday `rpc-allday-dedup-full-weekly` (`8 8 * * 0`, 400+ s) has ended. Same jobname +
-- same owner (postgres) ⇒ cron.schedule updates in place; jobid 542 asserted below.
-- Applied from Cowork cloud 2026-09-20 ~2:55 AM PT. Command untouched (single statement — a
-- VACUUM cannot share a command string).
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: Sunday 09-27 09:16Z run `succeeded` in < 30 s; store stays < 1 GB.
-- FALSIFIER: > 60 s again at :16 on a box with io_wait < 3 ⇒ the live set grew (check
--   pg_total_relation_size before the run), not the slot.
-- REVERT: SELECT cron.schedule('rpc-weekly-vacuum-full-pgnet-response', '43 9 * * 0', 'VACUUM FULL net._http_response');

SELECT cron.schedule('rpc-weekly-vacuum-full-pgnet-response', '16 9 * * 0', 'VACUUM FULL net._http_response');

DO $$
DECLARE v_id int; v_sched text; v_user text;
BEGIN
  SELECT jobid, schedule, username INTO v_id, v_sched, v_user
    FROM cron.job WHERE jobname = 'rpc-weekly-vacuum-full-pgnet-response';
  IF v_id IS DISTINCT FROM 542 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_sched <> '16 9 * * 0' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-weekly-vacuum-full-pgnet-response') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;

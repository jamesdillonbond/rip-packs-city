-- audit_20260827_move_jobid211_off_three_dead_slots
--
-- RECORD FILE for a change applied LIVE from a Cowork cloud session on
-- 2026-08-28 ~01:35Z (2026-08-27 18:35 PT) via `execute_sql`, NOT via
-- apply_migration. It creates no schema object; it is here so prod and repo do
-- not drift and so the revert path lives with the change.
--
-- ⚠ SCOPE OF THE NO-PUSH NOTE: the session that made this change could not push
-- (cloud git proxy: "not in this session's authorized repository set"). That is a
-- fact about THAT session. Trevor's machine and Claude Code push normally via the
-- PAT in remote.origin.pushurl. COMMIT THIS FILE AS USUAL.
--
-- WHAT AND WHY
-- pg_cron jobid 211 `rpc-refresh-allday-pack-realized` ran `35 */6 * * *`, i.e.
-- 00:35 / 06:35 / 12:35 / 18:35 UTC. Measured over the last 30 h:
--     00:35Z  succeeded in 59 s
--     06:35Z  failed at 600 s   (statement timeout)
--     12:35Z  failed at 600 s
--     18:35Z  failed at 600 s
-- and over its full retained history 00:35Z is 36/37 ok while the other three
-- slots run 42-54%. Successes take 32-106 s; failures burn the full 600 s
-- `cron_heavy` ceiling and roll back, ~1,800 s/day of the instance's binding
-- constraint returning nothing.
--
-- ⭐ The 59-second success in a QUIET window (active 1, io_wait 1, total 42)
-- refutes the remedy the ledger prescribes for this class ("split or shrink the
-- WORK, never raise the clock"): there is nothing to shrink. A job that finishes
-- in a minute at one slot and dies at ten minutes at three others is CONTENDED,
-- not oversized. This raises no clock and shrinks no work - it moves the job.
--
-- New slots 0,8,14,20 keep the PROVEN 00:35Z slot untouched and move only the
-- three that produced nothing at all today, onto the four lowest-timeout hours in
-- the measured day (hours 2/8/14/20 = 1.7/4.2/5.1/0.0 statement timeouts per
-- 1,000 runs, vs 0/6/12/18 = 16.0/25.6/51.0/21.4 - known-issues #42).
--
-- ⚠ FALSIFIER: over 7 days jobid 211 should succeed on >= 3 of 4 daily slots, in
-- the 30-120 s band, against 1 of 4 before. If 08:35/14:35/20:35 fail at 600 s as
-- often as 06/12/18 did, the hour-shape hypothesis does not transfer to this job
-- and this must be REVERTED.
--
-- METHOD (per docs/overnight/inbox/2026-08-16T0030Z-cron-heavy-jobs-ARE-
-- reschedulable-from-mcp-via-set-local-role.md): `SET LOCAL ROLE cron_heavy`
-- is LOAD-BEARING - without it cron.schedule re-owns the job as `postgres` and
-- silently drops the 600 s `rolconfig` statement_timeout. The command is read
-- into a local variable and never SELECTed (it carries a ?key= gate secret).
-- Probed first in a rolled-back DO block asserting schedule/owner/row-count.
--
-- REVERT: re-run this block with '35 */6 * * *'.

DO $$
DECLARE v_cmd text; v_after text; v_owner text; v_rows int;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobid = 211;
  IF v_cmd IS NULL THEN RAISE EXCEPTION 'jobid 211 not found'; END IF;

  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule('rpc-refresh-allday-pack-realized', '35 0,8,14,20 * * *', v_cmd);
  RESET ROLE;

  SELECT schedule, username INTO v_after, v_owner FROM cron.job WHERE jobid = 211;
  SELECT count(*) INTO v_rows FROM cron.job WHERE jobname = 'rpc-refresh-allday-pack-realized';

  IF v_after <> '35 0,8,14,20 * * *' THEN RAISE EXCEPTION 'schedule did not take: %', v_after; END IF;
  IF v_owner <> 'cron_heavy'          THEN RAISE EXCEPTION 'OWNER REGRESSION: %', v_owner; END IF;
  IF v_rows  <> 1                     THEN RAISE EXCEPTION 'duplicate cron row: %', v_rows; END IF;
END $$;

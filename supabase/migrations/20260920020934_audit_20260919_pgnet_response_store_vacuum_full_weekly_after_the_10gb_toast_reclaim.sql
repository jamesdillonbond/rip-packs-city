-- Register #75 / sentinel `pg_net Dispatch`: net._http_response had a 10 GB TOAST of dead response
-- bodies for a 7 MB heap and ~5.7k live rows (TTL 6 h). "VACUUM FULL is the lever and Trevor's
-- call" — taken 2026-09-19 7:08 PM PT on Trevor's "do what you think is best for RPC long term".
--
-- 📏 WHAT ACTUALLY HAPPENED, because the recorded expectation was wrong in the useful direction:
--   memory `vacuum-is-unreachable-on-this-instance` (08-18) had VACUUM as unreachable here (120 s
--   cluster default, single-statement only). This table is different in the one way that matters:
--   VACUUM FULL rewrites LIVE tuples, not dead ones — 5.7k live rows (~460 MB of live TOAST) copied,
--   the 10 GB of dead chunks simply unlinked. One-off single-statement pg_cron job as postgres
--   (jobid 541, `VACUUM FULL net._http_response`, no prefix; postgres holds MAINTAIN on the table
--   though supabase_admin owns it): **succeeded in 7.7 s**. net._http_response 10 GB → 469 MB;
--   pg_database_size 29,082 MB → 18,956 MB (−35 %). pg_net kept writing: newest response landed
--   23 s after the job started; queue 3. No lane saw a failure (cron.job_run_details clean).
--
-- This file schedules the same statement WEEKLY so the store cannot regrow to 10 GB: Sunday
-- 09:43Z (2:43 AM PT), the quiet band, no other job on that minute in that hour; ~8 s of
-- ACCESS EXCLUSIVE on a table whose writers retry on the next tick. As postgres, single statement,
-- no prefix (a prefix would make it a transaction block and VACUUM refuses).
--
-- EXIT: the `pg_net Dispatch` arm stops reading "response store ≥ 8.0 GB"; each Sunday tick reads
--   `succeeded` with return_message VACUUM and pg_total_relation_size stays under ~1 GB.
-- FALSIFIER: a Sunday run past 120 s (the cluster default kills it and the rewrite rolls back —
--   harmless but a signal the live set has grown past what fits the budget) ⇒ move it to a
--   cron_heavy-owned job IF cron_heavy is granted MAINTAIN, or shorten pg_net's TTL.
-- REVERT: SELECT cron.unschedule('rpc-weekly-vacuum-full-pgnet-response');

SELECT cron.schedule('rpc-weekly-vacuum-full-pgnet-response', '43 9 * * 0', 'VACUUM FULL net._http_response');

DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-weekly-vacuum-full-pgnet-response' AND username = 'postgres' AND schedule = '43 9 * * 0') <> 1 THEN
    RAISE EXCEPTION 'weekly vacuum job not scheduled as expected';
  END IF;
  IF NOT has_table_privilege('postgres', 'net._http_response', 'MAINTAIN') THEN
    RAISE EXCEPTION 'postgres lacks MAINTAIN on net._http_response';
  END IF;
END $$;

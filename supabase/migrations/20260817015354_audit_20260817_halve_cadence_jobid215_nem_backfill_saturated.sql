-- audit_20260817_halve_cadence_jobid215_nem_backfill_saturated
--
-- WHAT: cron jobid 215 `rpc-allday-nem-from-sales-backfill`, `*/30` -> `37 * * * *`.
-- Schedule only; the command is re-passed VERBATIM from the catalog (never retyped), so its
-- md5 must be unchanged afterwards: c7ea2df3c66232e984f4ce5839649a2b, length 196.
--
-- ⚠⚠ THE PERMISSION SURFACE, fully enumerated -- three attempts were needed, record this:
--   * 93 active jobs, TWO owners: `postgres` (51) and `cron_heavy` (42). Job 215 is
--     **cron_heavy's**; apply_migration runs as **postgres**.
--   * `postgres` HAS execute on cron.alter_job but does NOT own job 215
--       -> ERROR "Job 215 does not exist or you don't own it".
--   * `cron_heavy` OWNS job 215 but LACKS execute on cron.alter_job
--       -> ERROR "permission denied for function alter_job".
--     So alter_job is unreachable for this job from ANY available role.
--   * `cron_heavy` CAN execute cron.schedule (has_function_privilege), and pg_cron keys
--     uniqueness on (jobname, username), so calling it AS THE OWNER updates in place.
--   ⛔ Calling cron.schedule as `postgres` would create a SECOND, postgres-owned job running
--     the same backfill. The SET LOCAL ROLE is load-bearing, not cosmetic.
--   ⚠ **RESET ROLE at the end is MANDATORY**: apply_migration appends its own
--     `insert into supabase_migrations.schema_migrations`, and cron_heavy has no rights there
--     -- leaving the role set fails the whole migration with "permission denied for schema
--     supabase_migrations" (hit on the prior attempt; it rolled back cleanly, verified).
--   ⚠ The 2026-08-09 cadence cuts (jobids 235/236/237/240) needed none of this -- those are
--     postgres-owned. Do not generalise from them.
--
-- WHY -------------------------------------------------------------------------
-- jobid 215 is the single largest worker-time consumer on the instance:
-- **13,981 worker-seconds in 24 h** over 48 runs (avg 291 s/run), 3,335 s on failures, max 914 s.
--
-- It is SATURATED. Two independent measurements, 2026-08-17:
--
-- 1. GROWTH SERIES -- the measurement `finding-jobid215-scan-not-batch` recorded as owed and
--    never taken ("it needs a growth series, not a point reading"). AllDay rows added to
--    nft_edition_map per day:
--      08-11: 2,490 | 08-12: 309 | 08-13: 365 | 08-14: 390 | 08-15: 379 | 08-16: 286
--    Step change on 08-12, flat since; steady-state ~300/day now tracks AllDay unmapped inflow
--    (~231-240/24 h). The backfill has caught up to arrivals.
--
-- 2. HEAD-OF-SCAN-ORDER SAMPLE (n=400, in the function's own `ORDER BY us.nft_id`): of the first
--    400 unresolved AllDay nft_ids, **115 are recoverable and all 115 are already mapped**
--    (identical counts); the other 285 have no sale with a non-null edition_id and can never
--    produce a mapping. Zero new candidates at the head of its own ordering.
--
-- Status quo cost: ~46 worker-seconds per row mapped.
--
-- THE SECOND, INVISIBLE COST -- why now rather than filed: a pg_cron job killed at its ceiling
-- squats a background-worker slot for the full duration having written nothing, producing
-- `job startup timeout` on OTHER jobs. Live: 8 startup timeouts in 30 min across 6 jobs, three
-- sharing the identical start_time 2026-08-17 01:38:00.000193 -- the documented signature
-- (pg_cron stamps them at the scheduler tick; none actually ran). Those are uninstrumented
-- tier-B backfills that write no `pipeline_runs` row, so this is their ONLY signal.
--
-- HEADROOM: p_limit is 5,000 candidates/run against ~300 rows/day of real work; at hourly that
-- is still ~400x demand. New-NFT mapping latency rises from <=30 to <=60 min -- immaterial
-- against a ~47.5k-row AllDay backlog draining over weeks.
--
-- ⚠ HALVED, NOT LEAPT (08-09 precedent: conservative factor of 2, re-measure before going on).
-- ⚠ A CADENCE CUT IS NOT A SPEED FIX -- it reduces the NUMBER of attempts and cannot change
--   per-run duration. Do not read any change in average run time as caused by this.
-- ⚠ Minute 37 avoids the crowded fixed-minute slots (48,20,40,25,10,45,47,0,50,15) and the new
--   smoke cron at :17. Secondary -- the mechanism is DURATION overlap, not same-minute
--   collision -- but free.
--
-- ⚠ SCOPE OF EVIDENCE: measurement 2 is n=400 on ONE slice at the head of the ordering, not a
-- census -- the full candidate CTE times out at 25 s here, which itself corroborates that the
-- SCAN, not the insert, is the cost. Measurement 1 is 5 days. Re-measure if AllDay recoverable
-- volume rises.
--
-- POST-CHECK (run after applying): exactly ONE job named rpc-allday-nem-from-sales-backfill,
-- still jobid 215, username cron_heavy, schedule '37 * * * *', command md5 unchanged.
--
-- REVERT (safe any time; same role dance):
--   SET ROLE cron_heavy;
--   SELECT cron.schedule('rpc-allday-nem-from-sales-backfill', '*/30 * * * *',
--                        (SELECT command FROM cron.job WHERE jobid = 215));
--   RESET ROLE;
-- Reverting costs only worker-seconds and cannot lose data: the function is idempotent
-- (`ON CONFLICT (collection_id, nft_id) DO NOTHING`) and anything missed by one run is picked
-- up by the next.
-- -----------------------------------------------------------------------------

DO $guard$
DECLARE v_name text; v_sched text; v_user text; v_md5 text; v_n int;
BEGIN
  SELECT jobname, schedule, username, md5(command) INTO v_name, v_sched, v_user, v_md5
    FROM cron.job WHERE jobid = 215;

  IF v_name IS DISTINCT FROM 'rpc-allday-nem-from-sales-backfill' THEN
    RAISE EXCEPTION 'jobid 215 is %, not the nem backfill -- aborting', coalesce(v_name,'<missing>');
  END IF;
  IF v_sched IS DISTINCT FROM '*/30 * * * *' THEN
    RAISE EXCEPTION 'jobid 215 schedule is %, expected "*/30 * * * *" -- drifted or already applied, aborting', v_sched;
  END IF;
  IF v_user IS DISTINCT FROM 'cron_heavy' THEN
    RAISE EXCEPTION 'jobid 215 owner is %, expected cron_heavy -- aborting', v_user;
  END IF;
  IF v_md5 IS DISTINCT FROM 'c7ea2df3c66232e984f4ce5839649a2b' THEN
    RAISE EXCEPTION 'jobid 215 command md5 is %, expected c7ea2df3c66232e984f4ce5839649a2b -- aborting', v_md5;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-allday-nem-from-sales-backfill';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 job named rpc-allday-nem-from-sales-backfill, found % -- aborting', v_n;
  END IF;
END
$guard$;

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
         'rpc-allday-nem-from-sales-backfill',
         '37 * * * *',
         (SELECT command FROM cron.job WHERE jobid = 215)
       );

RESET ROLE;

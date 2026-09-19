-- 2026-09-18 evening audit (Cowork cloud). AUTHORED 21:55 PT 09-18 = 04:55Z 09-19.
-- ⚠ The filename stamp (05:55Z) is AHEAD of the authoring clock on purpose: it must sort after
--    20260919053000_..., already applied by the concurrent session. The stamp is a sequence key;
--    the line above is the honest time.
--
-- WHAT THIS DOES: moves the cross-collection cohort lane off the Pacific business afternoon.
--   rpc-ccm-step1 (jobid 60)  '10 23 * * *' -> '2 10 * * *'    (4:10 PM PT -> 3:02 AM PT)
--   rpc-ccm-step2 (jobid 4)   '25 23 * * *' -> '35 10 * * *'   (4:25 PM PT -> 3:35 AM PT)
-- Nothing else changes: no function body, no timeout, no data, no grant. cron.alter_job is used
-- rather than unschedule/schedule so the jobids, commands and active flags are preserved.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHY. The 2026-09-19T0310Z daytime-monitor filing reported cross_collection_cohort_mat ~52 h
-- stale after two consecutive rpc-ccm-step1 timeouts, and proposed a REINDEX of
-- idx_wmc_cohort_cover on the 2026-07-13 precedent (that one took step1 856s -> 54s).
-- A filed finding is a hypothesis. Re-derived 2026-09-18 21:30-21:50 PT:
--
--  ✅ HOLDS. step1 failed 09-17 and 09-18 at 600.0s / 600.1s on the CREATE TEMP TABLE aggregate.
--     cross_collection_cohort_mat last written 2026-09-16 16:11 PT (corroborated independently by
--     pg_stat_user_tables.last_autoanalyze) => 53.5 h stale. Sole reader is the view
--     cross_collection_cohort_stats, backing /insights/cross-collection. No freshness arm covers it
--     (board_mv_refresh_stale_hours guards the board MVs, not this mat).
--     ⚠ The 600s ceiling is NOT this function's own `SET statement_timeout TO '180s'` -- proconfig
--       statement_timeout is INERT on the pg_cron path; the binding value is cron_heavy's role
--       default, and the observed 600.0s durations confirm it.
--
--  ⛔ REFUTED: "step2 is FRESH; step1 is the specific failure." step2 ALSO timed out on 09-17
--     (300.1s) and on 09-12, and its 09-18 success took 110.3s against a 13.5-36.7s baseline
--     (3-8x). Both steps are degrading. step1 merely crosses its ceiling first.
--
--  ⛔ REFUTED AS SUFFICIENT CAUSE: index bloat. idx_wmc_cohort_cover is 321 MB over 2,157,979 rows;
--     expected for (text, uuid) INCLUDE (numeric) at ~56-60 B/tuple, 90% fill is ~130-146 MB
--     => ~2.2x, not the 4.5x of 07-13. At this estate's measured ~22 MB/s IO burst floor that is a
--     ~15s scan vs ~6s rebuilt: a REINDEX buys ~9s against a 550s shortfall. THE ARITHMETIC RULES
--     THE CAUSE OUT BEFORE ANY PROBE IS RUN. Nor is it a plan flip -- EXPLAIN still returns
--     Index Only Scan using idx_wmc_cohort_cover -> GroupAggregate, no sort. Nor an obvious
--     visibility-map rot -- n_dead_tup 1.29%, the table already carries
--     autovacuum_vacuum_scale_factor=0.02, autovacuum_count 1,286, last autovacuum 45 min prior.
--     ⚠ A REINDEX remains defensible on its own merits (321 MB -> ~140 MB on an index serving
--       13,506 scans / 84.2M tuple reads) but it is an OPTIMISATION, NOT THIS FIX, and shipping it
--       here would let it be credited with whatever happens next.
--
--  ⛔ REFUTED, adjacent: "the wmc FMV drain is backlogged and churning the table." It was caught
--     mid-run at 195s on DataFileRead, which invites exactly that story. rwfc_state.last_cutoff lag
--     is 11.8 min -- ONE cadence -- with 509 pending editions. The 08-30 "~50 min behind" state
--     recorded in that function's own comment is fixed and has stayed fixed.
--     ⚠ Its OCCUPANCY is recorded as capacity, not cause: on 09-17 rpc-refresh-wmc-fmv-changed
--       (7-57/10) burned 444.3 min (31% of the day; worst tick 531s of a 600s cadence) and
--       rpc-allday-unmapped-atlas-resolver (4-59/5) burned 352.8 min -- ~55% of wall-clock between
--       them on a 2-core SMALL instance, against 50.8 + 73.4 min on calm 09-15.
--
--  📏 WHAT THE EVIDENCE SUPPORTS: contention, with an hour-of-day lever. 7-day profile, PT, on a
--     FLAT population (~2,650-2,790 runs in every hour, so this is not a scheduling-density
--     artefact):
--         hour 16 (step1 today) : 477.6 busy-min/7d,  66 timeouts, avg 10.81s
--         hour  1               : 300.9              , 21        , avg  6.63s
--         hour  2               : 316.5              , 24        , avg  6.98s
--         hour  3               : 309.3              , 21        , avg  6.84s
--         hour 11 (worst)       : 1357.6             , 194       , avg 29.45s
--     🚨 The 16:05-16:30 PT window average (09-18: 21.34s) is NOT quotable as step1's cause --
--        step1's own 600s run is INSIDE it. Your own probe is the load, and here the suspect is a
--        member of the population it is being measured against.
--
-- WHY THIS CHANGE IS RIGHT EVEN IF THE OWED PROBE REFUTES CONTENTION -- three independent legs:
--   1. ~35% less ambient load and ~64% fewer ambient timeouts at the destination hour.
--   2. ⭐ It moves an ACCESS EXCLUSIVE TRUNCATE on a reader-facing table out of the Pacific
--      business afternoon -- the daytime-lock trade the 08-18/08-21 filings flagged, and the exact
--      item the monitor left as "Trevor's call on timing". At 3 AM PT there is no call to make.
--   3. It widens the step1->step2 gap from 15 min to 33 min. TODAY'S GAP IS NARROWER THAN STEP1'S
--      OWN 600s CEILING: a step1 that runs to budget ends 23:20Z, five minutes before step2 starts.
--      That latent collision is removed, not relocated.
--
-- DESTINATION MINUTES were chosen against the LIVE cron.job table, not a doc (the 0011Z filing's
-- HIGH-ish item died precisely because it read a cadence from a stale doc). 10:02Z and 10:35Z are
-- clear of every daily neighbour (next is 10:51Z rpc-reconcile-saved-wallet-stats-big) and of the
-- Sunday-only rpc-weekly-wmc-prune at 10:20Z +600s -- which matters because step2 SEQUENTIALLY
-- SCANS wallet_moments_cache and the prune deletes from it.
--
-- 🔬 OWED: EXPLAIN (ANALYZE, BUFFERS) on step1's aggregate in a genuinely quiet window, bounded by
--    SET LOCAL statement_timeout so the probe cannot run away. `Heap Fetches:` separates the R101
--    visibility-map class from contention; buffers separate bloat from both. NOT taken during this
--    pass: the DB held io_wait 8-10 / active 9-11 throughout, with REFRESH MATERIALIZED VIEW
--    CONCURRENTLY allday_special, refresh_topshot_special_serial_owners_mv,
--    reconcile_wmc_metadata_from_editions(1200,45) and the 195s wmc drain all in flight. A 321 MB
--    index-only scan launched into that would have been the load and its number would have
--    described the probe, not the query.
--
-- ⚠ CHANGE POINT: 2026-09-18 ~10 PM PT. Any duration or failure rate for jobids 60 and 4 that spans
--   it is pooled across a change and measures the change's absence. Pre-change record --
--   step1: 16.6 / 36.7 / 25.7 / 50.2 s (09-13..09-16) then TIMEOUT, TIMEOUT.
--   step2: 13.5 / 16.2 / 36.5 / 28.8 s then TIMEOUT (09-17), 110.3 s (09-18).
--
-- FALSIFIER: a step1 timeout at 10:02Z on a day whose whole-estate 09:55-10:40Z window averages
--   under ~8 s (a genuinely calm destination) refutes this as sufficient -- the cause is then
--   intrinsic to the query, and the OWED probe plus the REINDEX/restructure branch re-open.
-- NO-CHANGE CONTROL: rpc-allday-unmapped-atlas-resolver is deliberately NOT touched. It shares the
--   IO but not the table-access pattern; if IT improves by the same margin over the same days, the
--   improvement is the estate calming down, not this change.
--
-- REVERT: select cron.alter_job(4, schedule => '25 23 * * *');
--         set role cron_heavy;
--         select cron.schedule('rpc-ccm-step1','10 23 * * *','SELECT public.refresh_cross_collection_cohort_step1()');
--         reset role;
-- ─────────────────────────────────────────────────────────────────────────────────────────────

DO $mig$
DECLARE
  v_s1_before text;
  v_s2_before text;
  v_s1_after  text;
  v_s2_after  text;
  v_id1       bigint;
  v_id2       bigint;
  v_cmd1      text;
  v_cmd1_after text;
  v_n1        int;
BEGIN
  -- NON-VACUITY: resolve by NAME and assert the population exists and is what the header claims.
  SELECT jobid, schedule INTO v_id1, v_s1_before FROM cron.job WHERE jobname = 'rpc-ccm-step1';
  SELECT jobid, schedule INTO v_id2, v_s2_before FROM cron.job WHERE jobname = 'rpc-ccm-step2';

  IF v_id1 IS NULL OR v_id2 IS NULL THEN
    RAISE EXCEPTION 'cohort lane not found by name (step1=%, step2=%) - refusing to guess a jobid',
      v_id1, v_id2;
  END IF;

  -- Idempotent: if a rerun finds the destination already in place, do nothing and say so.
  IF v_s1_before = '2 10 * * *' AND v_s2_before = '35 10 * * *' THEN
    RAISE NOTICE 'cohort lane already on the destination schedule - no change';
    RETURN;
  END IF;

  -- Refuse to move a lane that is not where the header measured it. If another session has already
  -- rescheduled these, the whole "why" above was reasoned against a schedule that no longer exists.
  IF v_s1_before <> '10 23 * * *' OR v_s2_before <> '25 23 * * *' THEN
    RAISE EXCEPTION 'cohort lane is not on the measured schedule (step1=%, step2=%) - expected '
      '''10 23 * * *'' / ''25 23 * * *''. Re-derive before moving it.', v_s1_before, v_s2_before;
  END IF;

  -- ⚠ THE TWO HALVES OF THIS LANE HAVE DIFFERENT OWNERS, AND DIFFERENT PRIVILEGES REACH THEM.
  --   jobid 4 (step2) is owned by postgres; jobid 60 (step1) is owned by cron_heavy.
  --   Measured, not assumed (has_function_privilege / has_table_privilege, 2026-09-18 22:0x PT):
  --     cron.alter_job   : postgres EXECUTE = true,  cron_heavy EXECUTE = FALSE
  --     cron.schedule    : postgres EXECUTE = true,  cron_heavy EXECUTE = true
  --     cron.job (table) : postgres UPDATE  = FALSE, cron_heavy UPDATE  = FALSE  (owner supabase_admin)
  --   So there is exactly ONE path to jobid 60: assume cron_heavy (postgres is a member) and use
  --   cron.schedule(job_name, ...), which pg_cron 1.6.4 UPSERTS on (jobname, username), keeping the
  --   jobid. cron.schedule is NOT SECURITY DEFINER, so the row keeps username = cron_heavy.
  --   ⛔ Two earlier attempts failed and rolled back cleanly, which is what the guards are for:
  --      (1) alter_job as postgres -> 'Job 60 does not exist or you don''t own it'
  --      (2) alter_job as cron_heavy -> 'permission denied for function alter_job'
  --   ⭐ And this is the direct proof of the header's claim about the ceiling: step1 RUNS AS
  --      cron_heavy, so the binding 600 s is that role's default, not the function's inert proconfig.
  PERFORM cron.alter_job(v_id2, schedule => '35 10 * * *');

  -- Reproduce step1's command byte-for-byte out of the catalogue rather than retyping it.
  SELECT command INTO v_cmd1 FROM cron.job WHERE jobid = v_id1;
  IF v_cmd1 IS NULL OR btrim(v_cmd1) = '' THEN
    RAISE EXCEPTION 'refusing to re-schedule step1 with an empty command';
  END IF;

  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule('rpc-ccm-step1', '2 10 * * *', v_cmd1);
  RESET ROLE;

  -- Read the change BACK from the catalogue rather than trusting the call's return.
  SELECT schedule INTO v_s1_after FROM cron.job WHERE jobid = v_id1;
  SELECT schedule INTO v_s2_after FROM cron.job WHERE jobid = v_id2;

  IF v_s1_after <> '2 10 * * *' OR v_s2_after <> '35 10 * * *' THEN
    RAISE EXCEPTION 'reschedule did not take (step1=%, step2=%)', v_s1_after, v_s2_after;
  END IF;

  -- cron.schedule() UPSERTS, so the failure mode to rule out is that it INSERTED a duplicate
  -- instead of updating jobid 60. Assert exactly one row by that name, on the original jobid,
  -- still owned by cron_heavy, still carrying the original command.
  SELECT count(*) INTO v_n1 FROM cron.job WHERE jobname = 'rpc-ccm-step1';
  IF v_n1 <> 1 THEN
    RAISE EXCEPTION 'expected exactly one rpc-ccm-step1 after the upsert, found %', v_n1;
  END IF;
  SELECT command INTO v_cmd1_after FROM cron.job WHERE jobid = v_id1;
  IF v_cmd1_after IS DISTINCT FROM v_cmd1 THEN
    RAISE EXCEPTION 'step1 command changed (% -> %) - this migration moves WHEN, never WHAT',
      v_cmd1, v_cmd1_after;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_id1 AND username = 'cron_heavy') THEN
    RAISE EXCEPTION 'step1 lost its cron_heavy ownership - that owns its 600 s ceiling';
  END IF;

  -- The commands and active flags must be untouched: this migration moves WHEN, never WHAT.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid IN (v_id1, v_id2) AND NOT active) THEN
    RAISE EXCEPTION 'a cohort job came out INACTIVE - reverting expectation violated';
  END IF;

  RAISE NOTICE 'cohort lane moved: step1 % -> %, step2 % -> %',
    v_s1_before, v_s1_after, v_s2_before, v_s2_after;
END
$mig$;

COMMENT ON TABLE public.cross_collection_cohort_mat IS
  'Cohort of wallets holding >=3 collections, rebuilt daily by refresh_cross_collection_cohort_step1() '
  '(pg_cron rpc-ccm-step1). Read only by the view cross_collection_cohort_stats, which backs '
  '/insights/cross-collection. '
  '⚠ THE REBUILD IS ALL-OR-NOTHING AND ITS FAILURE IS INVISIBLE: step1 TRUNCATEs and re-INSERTs '
  'inside one transaction, so a statement_timeout rolls the whole tick back and this table simply '
  'keeps serving its previous contents with an old computed_at. There is NO freshness arm on it - '
  'board_mv_refresh_stale_hours guards the board MVs, not this mat - so two consecutive failed '
  'ticks on 2026-09-17 and 09-18 left it 53.5 h stale and nothing alarmed. '
  '⛔ Do NOT widen the timeout to fix a failure here: this function''s own SET statement_timeout is '
  'INERT on the pg_cron path (the binding value is cron_heavy''s role default, observed 600 s). '
  '📅 Rebuilt at 10:02Z (3:02 AM PT) since 2026-09-18; it ran at 23:10Z (4:10 PM PT) before that, '
  'and the move also took an ACCESS EXCLUSIVE TRUNCATE on this reader-facing table out of the '
  'Pacific business afternoon. Split any duration or failure rate on that change point.';

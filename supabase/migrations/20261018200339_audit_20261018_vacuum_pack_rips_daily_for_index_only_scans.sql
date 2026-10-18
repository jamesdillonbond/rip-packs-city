-- 2026-10-18 (Claude Code cloud) — daily VACUUM (ANALYZE) of pack_rips so the All Day pack page's
-- index-only scans stop visiting the heap. Same pattern as 20261003132500 (panini_card_serials).
--
-- WHY: the occasional 5 s timeouts on /[collection]/pack/dist/[distId] (`allday_pack_lifecycle`,
-- `pack_realized_ev`) trace to pack_rips' visibility map. EXPLAIN (ANALYZE, BUFFERS) of
-- v_allday_pack_lifecycle for dist 6924, 10-18 ~1:00 PM PT: 691 ms, 683 of it in an Index Only Scan on
-- idx_pack_rips_dist_agg_v4 with **715 heap fetches for 1,887 rows** (353 cold reads). pack_rips (2.3 GB,
-- 3.7 M rows) was 72.1 % all-visible: autovacuum last ran 10-16, dead tuples 1.5 % (under its 2 % trigger)
-- and its cost limit is deliberately 50, so the pricing lanes' updates outrun it. A manual VACUUM only
-- reads the pages not yet all-visible plus an index pass, at 4:37 AM PT (off-peak); owner postgres,
-- matching 20261003132500. Precedent: the 08-28 one-shot vacuum of this table took 33.6 s
-- (20260829005435 removed it only because its schedule would have re-fired yearly).
--
-- READ AFTER THE FIRST RUN (10-19 ~4:37 AM PT): relallvisible / relpages should be ~99 %, and the same
-- EXPLAIN should show Heap Fetches near 0. If heap fetches climb back within a day, the writers outrun
-- daily — measure before raising the cadence.
-- REVERT: SELECT cron.unschedule('maint-vacuum-pack-rips');

SELECT cron.schedule('maint-vacuum-pack-rips', '37 11 * * *',
                     'VACUUM (ANALYZE) public.pack_rips');

DO $$
DECLARE v_n int; v_sched text; v_user text;
BEGIN
  SELECT count(*), max(schedule), max(username) INTO v_n, v_sched, v_user
    FROM cron.job WHERE jobname = 'maint-vacuum-pack-rips';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected one job, found %', v_n; END IF;
  IF v_sched <> '37 11 * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'unexpected owner: %', v_user; END IF;
END $$;

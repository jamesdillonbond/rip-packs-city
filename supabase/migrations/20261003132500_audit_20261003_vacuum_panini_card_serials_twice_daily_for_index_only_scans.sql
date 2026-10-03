-- 2026-10-03 (PT) — `VACUUM (ANALYZE) public.panini_card_serials` twice a day (4:04 AM and
-- 12:04 PM PT), so the public Panini sale-feed board keeps its index-only scan.
--
-- SYMPTOM. Sentinel WARN 10-03 6:04 AM PT, Trust Health `public_board_slow_count = 1`:
-- `panini_sale_feed_status` 3,847 ms against its 3,000 ms budget (liveness sweep 4:28 AM PT).
-- 20261002151400 had fixed the same breach the day before with a covering index
-- (7.7 s -> 0.72 s).
--
-- CAUSE (EXPLAIN ANALYZE, 6:20 AM PT): the plan still uses that index —
-- `Parallel Index Only Scan using idx_panini_serials_feed_status` — but with
-- **Heap Fetches 280,877** and 51,911 blocks read, 4.2 s. An index-only scan is only
-- index-only for pages the visibility map marks all-visible: 163,007 of 208,004 pages
-- (78.4 %). The Panini walks UPDATE serial rows all day (n_tup_upd 3.0 M, 1.2 M HOT),
-- every update clears its page's all-visible bit, and only VACUUM sets it again. Autovacuum
-- had not run since 10-01 7:37 PM PT although the table carries
-- `autovacuum_vacuum_scale_factor = 0.02`: HOT pruning reclaims most dead tuples in-line,
-- so `n_dead_tup` sits near 9 k and never reaches the ~25 k trigger. Nothing else sets
-- the bits back.
--
-- WHAT. A scheduled plain VACUUM (ANALYZE), the `maint-vacuum-sales-hot-partition`
-- pattern. It scans only the not-all-visible pages (~45 k / ~350 MB today) and takes no
-- exclusive lock. 11:04Z follows the Panini team walk (3:35 AM PT) and precedes the 11:28Z
-- liveness sweep; 19:04Z precedes the 20:28Z sweep. Minute 4 is clear of the crowded :07 /
-- :13 / :53 slots. The one-off run that proved it is recorded in the ledger.
--
-- FALSIFIER: a liveness sweep after a scheduled run reading panini_sale_feed_status
-- > 3,000 ms, or EXPLAIN showing Heap Fetches in the hundreds of thousands, means the
-- writers outrun twice-daily — measure relallvisible before raising the cadence.
-- REVERT: SELECT cron.unschedule('maint-vacuum-panini-card-serials');

SELECT cron.schedule('maint-vacuum-panini-card-serials', '4 11,19 * * *',
                     'VACUUM (ANALYZE) public.panini_card_serials');

DO $$
DECLARE v_n int; v_sched text; v_user text;
BEGIN
  SELECT count(*), max(schedule), max(username) INTO v_n, v_sched, v_user
    FROM cron.job WHERE jobname = 'maint-vacuum-panini-card-serials';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected one job, found %', v_n; END IF;
  IF v_sched <> '4 11,19 * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'unexpected owner: %', v_user; END IF;
END $$;

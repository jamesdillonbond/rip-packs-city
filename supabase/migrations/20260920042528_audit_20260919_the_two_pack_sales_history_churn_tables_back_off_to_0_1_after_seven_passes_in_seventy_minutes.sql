-- Correction to 20260920031313, measured 70 minutes later. allday_pack_sales_history and
-- topshot_pack_sales_history are UPDATE-heavy (n_tup_upd 13.7 M and 21.0 M since the stats
-- reset), not read-mostly: at 0.02 (thresholds ~11 k / ~12 k dead) allday autovacuumed SEVEN
-- times between 8:00 and 9:20 PM PT (autovacuum_count 16 → 23) and topshot FOUR (58 → 62) —
-- a pass every ~10 min on a 141 MB + 177 MB table and every ~17 min on a 168 MB + 219 MB one,
-- each a full index pass. Dead-tuple rate measured ≈ 11 k per 10 min on allday. That is the
-- R117 shape (wmc: ~3.4 h/day of full-index passes at 0.02) created on two more tables tonight.
--
-- 0.1 (≈ 55 k / 59 k dead) ≈ 1.2 passes/hour on allday, ~0.7 on topshot: the map is restored
-- hourly instead of every ten minutes, at roughly a fifth of the index-read bytes. Before
-- tonight the default 0.2 never fired (allday: 16 passes in weeks, map at 0 %), so this is
-- still 5× the old cadence and the maps stay clean between passes.
-- Applied from Cowork cloud 2026-09-19 9:25 PM PT. ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: 09-20 evening, autovacuum_count on each advanced by ~24–30 (not ~150) and
-- relallvisible/relpages still > 90 % on both.
-- FALSIFIER: a map < 80 % a day later ⇒ the churn outruns hourly passes; go to 0.05, not 0.02.
-- REVERT: ALTER TABLE … SET (autovacuum_vacuum_scale_factor = 0.02) on both.

ALTER TABLE public.allday_pack_sales_history  SET (autovacuum_vacuum_scale_factor = 0.1);
ALTER TABLE public.topshot_pack_sales_history SET (autovacuum_vacuum_scale_factor = 0.1);

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_class c, unnest(c.reloptions) o
       WHERE c.relname IN ('allday_pack_sales_history','topshot_pack_sales_history')
         AND c.relnamespace = 'public'::regnamespace AND o = 'autovacuum_vacuum_scale_factor=0.1') <> 2 THEN
    RAISE EXCEPTION 'back-off not applied';
  END IF;
END $$;

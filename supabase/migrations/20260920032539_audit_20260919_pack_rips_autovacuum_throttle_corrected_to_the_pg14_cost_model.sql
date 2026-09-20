-- Correction to 20260920032225, ten minutes later. ⚠ The ALTER TABLE … SET (reloptions) in that
-- migration took SHARE UPDATE EXCLUSIVE, which an autovacuum worker yields to — so it CANCELLED
-- the pack_rips pass in flight (autovacuum_count stayed 2, 66.7 % visible), and the trigger
-- re-fired at 8:22:57 PM PT under the new settings. Those settings were sized on the OLD cost
-- model: with PG14+'s vacuum_cost_page_miss = 2 (not 10), 200 credits per 20 ms is ~5,000 page
-- misses/s ≈ 40 MB/s — above the tier's ~22 MB/s disk, i.e. no throttle at all. Measured: the
-- restarted pass scanned the 764 MB heap (cached) in 2 min and at 8:25 PM PT the box read
-- active 21 / IO-waiting 16 while its 1.28 GB index pass ran.
--
-- 50 credits per 50 ms = 1,000 credits/s = ~500 misses/s ≈ 4 MB/s: the index pass takes ~5 min
-- at a fifth of the disk instead of the whole disk for the same 5 min. This ALTER cancels the
-- running pass again (the same lock rule) and the trigger re-fires within the naptime with the
-- corrected pacing; the heap re-scan is cached and cheap.
-- Applied from Cowork cloud 2026-09-19 8:26 PM PT. ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: pack_rips autovacuum_count reaches 3 and relallvisible/relpages > 95 % with NO step in
-- `job startup timeout` rows while it runs.
-- FALSIFIER: still a step ⇒ pacing is not the lever (see 20260920032225's falsifier).
-- REVERT: ALTER TABLE public.pack_rips RESET (autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit);

ALTER TABLE public.pack_rips SET (autovacuum_vacuum_cost_delay = 50, autovacuum_vacuum_cost_limit = 50);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c, unnest(c.reloptions) o WHERE c.oid = 'public.pack_rips'::regclass AND o = 'autovacuum_vacuum_cost_limit=50') THEN
    RAISE EXCEPTION 'throttle not applied';
  END IF;
END $$;

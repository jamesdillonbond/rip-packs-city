-- Follow-up to 20260920031313 (eight tables get the 0.02 trigger). The trigger fired on
-- pack_rips within a minute (128 k dead > 73.8 k) and the autovacuum worker — cost_delay 2 ms,
-- effectively unthrottled on a 22 MB/s tier — scanned the 764 MB heap in ~4 min and then began
-- the 1.28 GB index pass. From 8:16 PM PT the estate read as a spell: `rpc-ts-listings-atlas-sync`
-- killed at 127 s and 120 s, and TEN `job startup timeout` rows at 8:18–8:19 PM (worker slots
-- squatted by lanes waiting on IO). An autovacuum worker cannot be cancelled from `postgres`
-- ("Only roles with the SUPERUSER attribute may cancel queries of roles with the SUPERUSER
-- attribute"), so this pass runs to completion; what CAN change is the next one.
--
-- Per-table cost throttle for pack_rips only: 20 ms delay / 200 limit ≈ 10× gentler than the
-- default, so a future pass reads ~2 MB/s for ~15 min instead of the disk's whole rate for 8.
-- Read by the worker when it STARTS a table, so it does not touch the pass in flight.
-- Applied from Cowork cloud 2026-09-19 8:22 PM PT. ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: the pack_rips autovacuum after this one shows in pg_stat_progress_vacuum for longer and
-- the failure table does not step while it runs.
-- FALSIFIER: the next pass still coincides with a step in `job startup timeout` rows ⇒ the
-- index pass is the cost regardless of delay (1.28 GB of indexes on 764 MB of heap — the same
-- 17-index shape wallet_moments_cache carries) and the lever is index count, not vacuum pacing.
-- REVERT: ALTER TABLE public.pack_rips RESET (autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit);

ALTER TABLE public.pack_rips SET (autovacuum_vacuum_cost_delay = 20, autovacuum_vacuum_cost_limit = 200);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c, unnest(c.reloptions) o WHERE c.oid = 'public.pack_rips'::regclass AND o = 'autovacuum_vacuum_cost_delay=20') THEN
    RAISE EXCEPTION 'throttle not applied';
  END IF;
END $$;

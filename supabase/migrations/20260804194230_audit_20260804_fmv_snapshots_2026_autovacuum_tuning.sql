-- fmv_snapshots_2026 is written delete-then-insert once per edition per sweep
-- (~19.4k TS editions/cycle, plus the other collections). At the default
-- autovacuum_vacuum_scale_factor = 0.2 the table must accumulate ~195k dead
-- tuples before autovacuum acts, so its visibility map sits stale for long
-- stretches. Measured 2026-08-04: 71.7% all-visible with 47.6k dead tuples,
-- which degraded the DISTINCT-ON-latest scan in topshot_serial_board_candidates
-- from an index-only scan into 146,370 heap fetches -- 51.4s, past the ~30s
-- read budget, silently failing topshot-active-listings-ingest 100/100 GHA runs
-- for 14 days. A manual VACUUM (ANALYZE) took it to 100% all-visible and the
-- function from 51.4s -> 2.64s.
--
-- This makes that maintenance automatic instead of a one-off. Scale factors are
-- tightened, not the cost limits, so each run stays small and frequent rather
-- than rare and large. insert_scale_factor matters here too: insert-only pages
-- are not covered by the dead-tuple trigger, and VM freshness is what this
-- table's readers actually depend on.
--
-- REVERT:
--   ALTER TABLE public.fmv_snapshots_2026
--     RESET (autovacuum_vacuum_scale_factor,
--            autovacuum_analyze_scale_factor,
--            autovacuum_vacuum_insert_scale_factor);

ALTER TABLE public.fmv_snapshots_2026 SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_insert_scale_factor = 0.05
);
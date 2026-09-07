-- audit_20260907: rpc-wmc-metadata-reconcile (jobid 456) */10 → 15,45 (every 30 min).
--
-- WHY (inbox 2026-09-05T1630Z, re-derived 2026-09-07 01:40Z before acting):
-- reconcile_wmc_metadata_from_editions converged 2026-09-04 ~21:00Z (99.6% of
-- its lifetime rows landed in its first 7 h). Since then it is the platform's #1
-- physical reader — 4.22M shared_blks_read / 82 calls over the last 13.7 h
-- (ops_pgss_delta), ~57K reads per tick, on an IO-bound SMALL instance — while
-- writing 2–220 rows/hour (last 24 h: 17 · 191 · 8 · 61 · 220 · 27 · 19 · 84 ·
-- 170 · 5 · 4 · 4 · 53 · 2 · 9 · 5 · 68 · 2 · 3 · 5 · 6 · 74 · 5). cycles = 16
-- and advancing (a full-population sweep every ~4.3 h). All three of the
-- filing's falsifiers hold: rows_written has not climbed, it IS #1 by reads,
-- cycles advance. The 48-h collision window on the 09-04 work has passed.
--
-- DECISION (delegated — Trevor 2026-09-06 "keep doing all you can"): halve the
-- read cost twice over (every 30 min instead of 10 → ~67% fewer reads, ~5.5M/day
-- saved) while still catching new drift within 30 min. NOT retired: the
-- post-drain writes ARE the reconciler working (truncated/placeholder set names
-- arriving with new data). Minutes 15,45 chosen from the live schedule set:
-- nothing else hourly on either, and neither is in the stagger ban
-- (0,1,20,21,40,41). Same jobname → same jobid (456), same command.
--
-- WATCH / EXIT: cycles keeps advancing (one full sweep every ~13 h now);
-- rows_written per tick stays in the same band (a tick writing thousands means
-- drift is bursty and this cadence is too slow — go to */15, or event-trigger).
-- FALSIFIER: if a user-visible truncated set name is reported with age > 30 min
-- after its ingest, the cadence is the cause.
--
-- REVERT: SELECT cron.schedule('rpc-wmc-metadata-reconcile', '*/10 * * * *',
--   'SELECT public.reconcile_wmc_metadata_from_editions(1200, 45)');

SELECT cron.schedule(
  'rpc-wmc-metadata-reconcile',
  '15,45 * * * *',
  'SELECT public.reconcile_wmc_metadata_from_editions(1200, 45)'
);

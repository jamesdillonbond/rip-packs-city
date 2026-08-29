-- Six wallet-backfill* cadence arms sat at max_silent_minutes = 420 against a
-- cadence that cannot meet it. Measured 2026-08-28 (PT) over the full 72h
-- pipeline_runs retention window, max inter-run gap per pipeline:
--
--   wallet-backfill                            677 min
--   wallet-backfill-allday                     673 min
--   wallet-backfill-golazos                    677 min
--   wallet-backfill-multicollection-dispatch   677 min
--   wallet-backfill-pinnacle                   677 min
--   wallet-backfill-ufc                        677 min
--
-- The cause is NOT a fault. app/api/seed-wallet-refresh/route.ts gates on
-- `utcHour % 12 >= 2` (the 2026-07-18 Phase 2 cost lever, ~56 lambda-hours/day),
-- so waves execute only in UTC hours 0, 1, 12, 13. Structural worst case, with
-- no wave missed at all: a wave finishing at 00:05 and the next starting at
-- 12:59 is ~774 min. NO threshold below ~780 can ever be green.
--
-- An arm that cannot be green carries zero information and trains a reader to
-- skip six `high` rows daily, which is how a genuinely missed wave gets missed.
-- 800 is NOT a fresh number chosen to get green: `wallet-backfill-multicollection-complete`
-- — the seventh member of this same family — has been at 800/medium since before
-- this pass, set by someone who reached the same conclusion and fixed one row of
-- seven. This aligns the other six with that existing precedent.
--
-- A skipped wave is still caught: it produces a 24h+ gap, well past 800.
--
-- Severity is deliberately UNCHANGED (`high`). The claim being made is still
-- "the wallet refresh family has stopped"; only the threshold at which that
-- claim becomes true is corrected.
--
-- ⚠ Prior value was UNIFORMLY 420 across exactly these six rows (verified
-- immediately before this migration). No backup table is created: a single
-- uniform scalar recorded here and in the ledger IS the backup, and an RLS-less
-- `bak_*` table in `public` would trip the security advisors for no benefit.
-- REVERT: set max_silent_minutes = 420 for the six pipelines named below.
--
-- ⚠ Named explicitly, never `wallet-backfill%` — that wildcard also matches
-- `wallet-backfill-multicollection-complete`, whose 800 is not ours to restate,
-- and would silently capture any future sibling.
--
-- Guarded on `= 420` so a re-run is a no-op and a concurrent edit is not clobbered.

UPDATE public.pipeline_cadence_watchlist
SET max_silent_minutes = 800
WHERE pipeline IN (
  'wallet-backfill',
  'wallet-backfill-allday',
  'wallet-backfill-golazos',
  'wallet-backfill-multicollection-dispatch',
  'wallet-backfill-pinnacle',
  'wallet-backfill-ufc'
)
AND max_silent_minutes = 420;

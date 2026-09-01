-- audit_20260831 — fmv_from_cached_listings' NOT EXISTS anti-join reads ~9 snapshot
-- rows per edition and heap-fetches every one of them to reject 8, because
-- `confidence` is in none of the indexes it can use. This adds the partial index
-- that answers the existence test directly.
--
-- MEASURED 2026-08-31 (DB-timed, same warm state, baseline re-run to confirm
-- stability; instrument = TOTAL BUFFERS TOUCHED, not wall clock):
--   INSERT-leg body, collection 95f28a17-224a-4025-96ad-adf8a4c63bfd (nba_top_shot):
--     262,111 then 261,493 buffers / 14.6 s then 15.3 s
--     -> Nested Loop Anti Join node alone: 230,083 buffers over 19,923 loops
--        = 11.55 buffers per probe, `Rows Removed by Filter: 8`, actual rows=1
--   through the function (BEGIN / EXPLAIN ANALYZE / ROLLBACK):
--     543,576 buffers / 46.7 s
--   pg_stat_statements lifetime: 1,907 calls, 12,062 ms and 228,362 buffers per
--   call, 23,002 s total — the largest single production consumer on the board.
--
-- ⛔ THE OBVIOUS REWRITE WAS REJECTED BY MEASUREMENT, NOT TASTE.
-- Hoisting the cached_listings join above the anti-join
-- (`WITH m AS MATERIALIZED (...) SELECT ... WHERE NOT EXISTS ...`) cut buffers
-- 261,493 -> 11,553 (22.6x) — and made the leg SLOWER, 15.3 s -> 32.8 s, because
-- the anti-join is ALSO the pre-filter that halves the CPU-bound OR join:
-- `Rows Removed by Join Filter` went 1,030,559 -> 2,071,058 and each of those rows
-- evaluates normalize_name() four times. The join ORDER is correct as written.
-- Only the probe was expensive. That rewrite is not shipped.
--
-- SEMANTICS: none. This is an index-only addition; no function, view, ACL or row
-- is touched. Every plan that does not choose it behaves exactly as before.
--
-- REVERT (DB half, complete):
--   DROP INDEX IF EXISTS public.idx_fmv_snapshots_edition_high_med;
-- Dropping the parent index drops the per-partition children with it.
--
-- EXIT CONDITION / FALSIFIER: recorded by the follow-up COMMENT ON INDEX
-- migration applied in the same pass, whose numbers come from the post-fix
-- measurement rather than a hoped-for order of magnitude. If the anti-join node
-- does not fall below the 230,083 buffers it costs today, this index is dead
-- weight on a hot insert path and must be dropped with the line above.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_fmv_snapshots_edition_high_med
  ON public.fmv_snapshots (edition_id)
  WHERE confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence);

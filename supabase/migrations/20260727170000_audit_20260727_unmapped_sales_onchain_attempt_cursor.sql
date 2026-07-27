-- audit_20260727_unmapped_sales_onchain_attempt_cursor
--
-- WHY: both AllDay unmapped-sales resolvers select candidates with a bare
--   ORDER BY sold_at DESC LIMIT n
-- and carry NO cursor, offset, or attempt-tracking. An unresolved row keeps
-- resolved_at IS NULL forever, so every tick re-selects the SAME rows: the live
-- resolver's `candidates` has been pinned at 385/386 across every run, spending
-- 60 on-chain borrow attempts per tick on a fixed set that returns
-- onchain_nil=60 / onchain_err=0 / resolved=0 every single time.
--
-- Only ~400 open AllDay rows are newer than ~2026-04-08, so the live route's
-- newest-400 window plus the tail route's next-600 reach ~1,000 of 28,627 open
-- distinct nft_ids. The other ~27,600 have never been probed and, under the
-- current code, never can be.
--
-- This column is the attempt marker that lets the window ROTATE. It is
-- deliberately a real column rather than another resolution_hint key so the
-- selection stays a single indexed ORDER BY (the table already uses
-- resolution_hint->>'promote_recheck_after' as a horizon, but that one is
-- consulted per-row by promote_unmapped_sales, never used for ordering).
--
-- NULLS FIRST is the point: never-attempted rows sort ahead of attempted ones,
-- so the first run after deploy behaves EXACTLY like today (every row NULL =>
-- newest-sold first) and only then begins to rotate.
--
-- MEASUREMENT NOTE (2026-07-27, Claude Code): an independent on-chain probe of
-- 40 randomly-sampled rows from the never-reached region resolved 0/40 (zero
-- transport errors; every tx returned HTTP 200 with a decoded AllDay.Deposit.to
-- whose holder no longer borrows). A same-method probe of 11 in-window rows also
-- resolved 0/11. So this change is NOT expected to unlock a large recovery — it
-- stops the pipeline burning a fixed Flow REST budget re-probing a proven-dead
-- set, and makes the backlog's true resolvability measurable instead of assumed.
--
-- REVERT:
--   DROP INDEX IF EXISTS public.idx_unmapped_sales_onchain_attempt_cursor;
--   ALTER TABLE public.unmapped_sales DROP COLUMN IF EXISTS last_onchain_attempt_at;

ALTER TABLE public.unmapped_sales
  ADD COLUMN IF NOT EXISTS last_onchain_attempt_at timestamptz;

COMMENT ON COLUMN public.unmapped_sales.last_onchain_attempt_at IS
  'When an on-chain edition-resolution borrow was last ATTEMPTED for this row '
  '(set by /api/cron/allday-resolve-unmapped and -tail regardless of outcome). '
  'NULL = never attempted. Drives the rotating candidate window so the resolvers '
  'stop re-probing the same newest-N rows every tick. Not a resolution marker — '
  'resolved_at remains the only success signal.';

-- Partial index over exactly the resolver predicate (open rows), with the
-- ordering the routes now use: never-attempted first, then oldest-attempt first,
-- newest-sold as the tiebreak.
CREATE INDEX IF NOT EXISTS idx_unmapped_sales_onchain_attempt_cursor
  ON public.unmapped_sales (collection_id, last_onchain_attempt_at NULLS FIRST, sold_at DESC)
  WHERE resolved_at IS NULL;

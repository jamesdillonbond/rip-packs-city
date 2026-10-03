-- 2026-10-02 (PT) — R107 residual, part 1 of 3: fmv_snapshots.updated_at.
--
-- WHY. FMV writes are delete-then-insert (never upsert), and a correction — the thin-
-- sale haircut, the disconnected-ask clamp, a marketplace re-pull — re-inserts the
-- row with its ORIGINAL computed_at. refresh_edition_fmv_current()'s incremental
-- branch read `computed_at > watermark - 2h`, so a correction older than two hours
-- never re-entered the window and edition_fmv_current published the PRE-correction
-- value to the eleven boards that read it until the 2:36 AM PT full reconcile (R107,
-- fixed 09-19/20; this is the residual its register row asked for: "an updated_at
-- column on fmv_snapshots would make the INCREMENTAL path see corrections within the
-- hour; today the bound is 24 h"). Live at 5:48 PM PT today, 15 h after the reconcile:
-- check_edition_fmv_current_source_drift() = 6 rows, cached vs source 2,999.00 vs
-- 1,649.45 (edition 99b090d0-…), 1,000 vs 550, 99 vs 54.45, 225 vs 191.25, 2 vs 1.1,
-- 1 vs 0.55 — every one the 0.55× haircut ratio, every one on a public board.
--
-- WHAT (this file). The column is ADDED WITHOUT a default and THEN given DEFAULT now(),
-- so the 1.87 M existing rows read NULL — a default on the ADD would have stamped them
-- all with the migration time and the next incremental window would have pulled the
-- whole table. Every writer inserts with an explicit column list (10 DB functions and
-- 2 routes checked; none `INSERT … SELECT *`), so every new and every re-inserted row
-- carries now() with NO writer change; there is no in-place UPDATE writer of
-- fmv_snapshots (prosrc sweep), so no trigger is needed.
--
-- Applied with `SET LOCAL lock_timeout = '8s'`: the first attempt (one combined
-- migration) sat 60 s behind a reader's lock and the MCP client gave up; split in three,
-- each part acquires its lock or fails fast. Parts: 20261003005833 (this), 20261003005846
-- (partial index), 20261003011236 (the refresh body).
--
-- Revert: ALTER TABLE public.fmv_snapshots DROP COLUMN updated_at (after the other two
--   parts are reverted; the DROP needs a human — the MCP holds it).

SET LOCAL lock_timeout = '8s';
ALTER TABLE public.fmv_snapshots ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.fmv_snapshots ALTER COLUMN updated_at SET DEFAULT now();
COMMENT ON COLUMN public.fmv_snapshots.updated_at IS
  'When this row was (re)written. NULL on rows that predate 2026-10-02 (no backfill, on purpose). FMV writes are delete-then-insert keeping the original computed_at, so this is the only column that moves on a correction; refresh_edition_fmv_current() keys its incremental window on it as well as on computed_at (R107 residual).';
DO $$
BEGIN
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='fmv_snapshots_2026' AND column_name='updated_at') IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION 'fmv_snapshots_2026.updated_at default is not now()';
  END IF;
  IF (SELECT count(*) FROM public.fmv_snapshots WHERE updated_at IS NOT NULL) > 0 THEN
    RAISE EXCEPTION 'updated_at was backfilled on existing rows';
  END IF;
END $$;

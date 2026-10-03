-- 2026-10-02 (PT) — R107 residual, part 2 of 3: a partial index on fmv_snapshots(updated_at)
-- WHERE updated_at IS NOT NULL — i.e. only rows written after part 1 (20261003005833), ~22 k a
-- day, so the per-partition builds ran over zero matching rows. It serves the incremental
-- refresh's new `updated_at > cutoff` leg (part 3, 20261003011236). Why part 1 is the context,
-- see that file's header.
--
-- Revert: DROP INDEX public.idx_fmv_snapshots_updated_at (needs a human — the MCP holds it).

SET LOCAL lock_timeout = '15s';
CREATE INDEX IF NOT EXISTS idx_fmv_snapshots_updated_at
  ON public.fmv_snapshots (updated_at)
  WHERE updated_at IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'fmv_snapshots_2026' AND indexdef ~ 'updated_at' AND indexdef ~ 'IS NOT NULL') THEN
    RAISE EXCEPTION 'partial updated_at index missing on fmv_snapshots_2026';
  END IF;
END $$;

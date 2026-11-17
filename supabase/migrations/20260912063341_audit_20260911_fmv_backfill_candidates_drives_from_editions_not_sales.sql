-- fmv_backfill_candidates: drive from `editions` (21,423 rows), not `sales` (4.9M).
--
-- WHY (measured 2026-09-11 PT, both plans on the SAME idle instance so the A/B is
-- warm-vs-warm rather than a cache artifact):
--
--   BEFORE  427,727 buffers + 55,406 TEMP blocks (16 hash batches, spills to disk)
--           11,129 ms on an IDLE instance
--   AFTER    75,105 buffers, no temp
--           3,237 ms cold / ~149 ms warm
--
-- 5.7x fewer buffers and the temp spill is gone. The old shape is this estate's
-- LIMIT-never-binds pathology: a Parallel Hash Anti Join over ALL EIGHT `sales`
-- partitions (2,446,494 rows x 2 workers) hashed against 743,191 `fmv_snapshots`
-- rows, with `LIMIT 100` sitting above a Sort/Group where it cannot short-circuit.
-- Because the true answer is ZERO the limit never binds, so every tick pays the
-- whole scan. The function carries `SET statement_timeout = '60s'`, and 11.1 s
-- idle is comfortably over 60 s under load -- which is exactly what production
-- shows: `fmv-backfill` succeeded only on a quiet instance and timed out on 8 of
-- its last 12 runs, keeping a HIGH-severity `failure_rate` alert permanently lit.
--
-- ⭐ THE ZERO IS CORRECT AND EXHAUSTIVELY VERIFIED, per partition, 2026-09-11:
--   sales_2020    922 editions, 0 missing a snapshot
--   sales_2021  1,309, 0     sales_2022  2,326, 0     sales_2023  7,431, 0
--   sales_2024 10,343, 0     sales_2025 11,542, 0     sales_2026 18,401, 0
-- So the backlog is empty across the ENTIRE history, not merely recently. This
-- lane is exhausted; the rewrite makes proving that cheap instead of removing the
-- lane, because a genuinely new edition still has to be caught.
--
-- ⭐ EQUIVALENCE IS PROVEN, NOT ASSUMED. The only way the two forms could differ
-- is a `sales.edition_id` absent from `editions` -- and `sales_edition_id_fkey`
-- FOREIGN KEY (edition_id) REFERENCES editions(id) makes that impossible. Control
-- run on the 2026 partition: 18,401 distinct edition_ids, 0 not present in
-- `editions`. ⚠ If that FK is ever dropped, this rewrite silently narrows and the
-- pin's orphan assertion is what will say so.
--
-- Semantics are otherwise unchanged: editions with at least one positive-price
-- sale and no `fmv_snapshots` row, capped to [1, 500]. The route's FMV math is
-- untouched.
--
-- Revert: re-apply the body from
-- supabase/migrations/20260626001900_fmv_backfill_candidates_antijoin_rpc.sql.

CREATE OR REPLACE FUNCTION public.fmv_backfill_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(ed_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
  SELECT e.id
  FROM public.editions e
  WHERE NOT EXISTS (
      SELECT 1 FROM public.fmv_snapshots f WHERE f.edition_id = e.id
    )
    AND EXISTS (
      SELECT 1 FROM public.sales s
      WHERE s.edition_id = e.id AND s.price_usd > 0
    )
  LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;

REVOKE ALL ON FUNCTION public.fmv_backfill_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_backfill_candidates(integer) TO service_role;

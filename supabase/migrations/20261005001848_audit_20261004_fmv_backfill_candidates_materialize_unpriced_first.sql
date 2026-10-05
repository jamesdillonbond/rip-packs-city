-- fmv_backfill_candidates: find the editions with NO snapshot first (a materialized
-- CTE), then probe `sales` only for those. Same answer, pinned join order.
--
-- WHY (measured 2026-10-04 ~5:30 PM PT, Cowork cloud, prod, generic plan forced
-- with `plan_cache_mode = force_generic_plan` + PREPARE, the way a LANGUAGE sql
-- function with SET clauses actually runs):
--
--   BEFORE (the 2026-09-12 body)  > 55,000 ms -- cancelled at a 55 s timeout
--   AFTER  (this body)                441 ms, 153,473 buffers, 2 disk reads
--
-- Production telemetry agreed: `fmv-backfill` took 15-60 s on every run 10-01..10-04
-- (avg 21 s on 10-01, 39 s on 10-04), and 2 of its last 10 runs hit the function's
-- own 60 s statement_timeout (10-03 11:23 PM, 10-04 4:21 PM PT) -- each one a HIGH
-- failure-rate row for a lane that has nothing to do.
--
-- MECHANISM. The 09-12 rewrite ("drive from editions, not sales") measured ~149 ms
-- warm when it shipped, but SQL does not fix a join order. Since then `editions`
-- grew 21,423 -> ~39,600 and the planner now picks a Merge Semi Join of
-- `editions_pkey` against a Merge Append over ALL EIGHT `sales_<year>` partition
-- indexes (~7.07 M index entries estimated), applying the snapshot anti-join last.
-- With a true answer of ZERO the LIMIT never binds, so every tick walks the whole
-- sales index -- the same LIMIT-never-binds pathology the 09-12 header describes,
-- re-entered through the other side.
--
-- The fix makes the cheap, selective step run first and cannot be reordered by
-- the planner: a MATERIALIZED CTE of editions with no fmv_snapshots row (a hash
-- anti-join, 61 rows today), then a per-edition EXISTS probe into the sales
-- indexes for just those (61 x 8 index probes, 1,281 buffers).
--
-- EQUIVALENCE. The set is unchanged by construction: {editions with no snapshot}
-- INTERSECT {editions with a positive-price sale}; only the evaluation order moved.
-- Measured on prod: both forms return 0 rows; the 61 snapshot-less editions have no
-- positive-price sale in any partition. The FK dependency recorded on 09-12
-- (sales_edition_id_fkey) is unchanged -- the pin's orphan assertion still holds.
-- The route's FMV math is untouched.
--
-- anon-exec: intentional — service_role only, unchanged; REVOKE below restates it (fmv_backfill_candidates)
--
-- Revert: re-apply the body from
-- supabase/migrations/20260912063341_audit_20260911_fmv_backfill_candidates_drives_from_editions_not_sales.sql
-- and the pin block in supabase/tests/fmv_backfill_candidates.sql + the drift-guard
-- registration row in __tests__/db-invariants-drift-guard.test.ts.

CREATE OR REPLACE FUNCTION public.fmv_backfill_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(ed_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
  WITH unpriced AS MATERIALIZED (
    SELECT e.id
    FROM public.editions e
    WHERE NOT EXISTS (
        SELECT 1 FROM public.fmv_snapshots f WHERE f.edition_id = e.id
      )
  )
  SELECT u.id
  FROM unpriced u
  WHERE EXISTS (
      SELECT 1 FROM public.sales s
      WHERE s.edition_id = u.id AND s.price_usd > 0
    )
  LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;

REVOKE ALL ON FUNCTION public.fmv_backfill_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_backfill_candidates(integer) TO service_role;

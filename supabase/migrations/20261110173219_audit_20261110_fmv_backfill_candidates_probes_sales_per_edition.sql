-- audit_20261110_fmv_backfill_candidates_probes_sales_per_edition
--
-- WHY. `fmv-backfill` timed out (`fmv_backfill_candidates: canceling statement due to
-- statement timeout`, its own 60 s) at 6:49 PM PT 11-08 and 4:29 AM PT 11-10; its successful
-- runs climbed 6 s (11-08 morning) -> ~40 s. The unpriced set is now 21,326 editions, ALL Candy
-- (the census created ~22k since 11-08; every other collection is fully priced), and with
-- that many the planner flattened the EXISTS into a hash semi-join over all 7.55M `sales` rows
-- across the partitions: measured 3.0M buffers / 23 s on an idle tick, for 0 rows returned.
--
-- FIX. The sales probe is `CROSS JOIN LATERAL (... LIMIT 1)`, which the planner cannot turn
-- into a join over all of `sales`: one index probe per unpriced edition per partition.
-- Measured 610k buffers / 1.6 s, same 0 rows. Same set by construction (a LATERAL with LIMIT 1
-- yields a row iff the EXISTS is true). Third plan-flip of this function as tables grew
-- (09-11 drive-from-editions, 10-04 MATERIALIZED unpriced) — this shape cannot flip back.
--
-- Pin supabase/tests/fmv_backfill_candidates.sql re-pinned (every assertion unchanged);
-- drift guard re-pointed here. Caller: app/api/fmv-backfill/route.ts only.
--
-- anon-exec: unchanged (fmv_backfill_candidates) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false on 11-10.
--
-- REVERT: re-apply the body from 20261005001848.

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
  -- 2026-11-10: the sales probe is a per-edition LATERAL ... LIMIT 1, not EXISTS. With the
  -- unpriced set at 21,326 (all Candy census editions) the planner turned EXISTS into a hash
  -- semi-join over all 7.55M sales rows (2.9M buffers, 23 s idle; two 60 s timeouts) for an
  -- answer of ZERO. A LATERAL with LIMIT 1 cannot be flattened into a join, so each unpriced
  -- edition is one index probe per partition: 610k buffers / 1.6 s. Same set.
  SELECT u.id
  FROM unpriced u
  CROSS JOIN LATERAL (
      SELECT 1 FROM public.sales s
      WHERE s.edition_id = u.id AND s.price_usd > 0
      LIMIT 1
    ) has_sale
  LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;


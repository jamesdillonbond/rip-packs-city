-- audit_20261110_fmv_backfill_candidates_prefilters_on_edition_fmv_current
--
-- WHY (Claude Code cloud, 2026-11-10 ~6:00 PM PT; daytime-monitor filing 2026-11-11T0112Z). `fmv-backfill` still hit
-- its 60 s statement_timeout on 3 of its last 10 runs after 20261110173219 (6:49 PM PT 11-08, 4:29 AM PT 11-10,
-- 4:35 PM PT 11-10), with ok runs at 24-41 s, for an answer of 0 every time. Measured 5:55 PM PT: 705k buffers /
-- 13.4 s. The unpriced set (20,855, all Candy #246 census editions) costs 256k of that: NOT EXISTS over fmv_snapshots
-- read the whole fmv_snapshots_2026 edition index (2.9M entries) -- ~17.6k of the run's ~21k cold reads.
--
-- FIX. (1) Prefilter on edition_fmv_current (one row per priced edition), then confirm each survivor against
-- fmv_snapshots: unpriced CTE 256k -> 95k buffers; whole call 705k -> 533k buffers, 13.4 s -> 4.2 s on the same
-- warmth. Same set: EXCEPT both ways = 0 (20,855 / 20,855) on 11-10. A lagging edition_fmv_current only ADDS
-- survivors that the fmv_snapshots check removes; an edition_fmv_current row with no snapshot behind it is
-- excluded (edition_fmv_current is derived from fmv_snapshots, so that row is stale-ahead) -- pinned.
-- (2) statement_timeout 60 s -> 90 s: the remaining cost is the per-edition sales probe (~438k buffers, 8
-- partitions x 20,855), which tips 60 s on cold IO under load; 90 s stays under the route's maxDuration 120 and
-- the ~120 s gateway. The set shrinks as #246 retires the name-only Candy editions.
--
-- Pin supabase/tests/fmv_backfill_candidates.sql re-pinned (+ edition_fmv_current fixture, + lag and stale-ahead
-- cases); drift guard re-pointed here. Caller: app/api/fmv-backfill/route.ts only.
--
-- anon-exec: unchanged (fmv_backfill_candidates) — CREATE OR REPLACE of an existing fn; ACL preserved (postgres, service_role only; anon/authenticated false, verified 11-10).
--
-- REVERT: re-apply the body from 20261110173219.

CREATE OR REPLACE FUNCTION public.fmv_backfill_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(ed_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '90s'
AS $$
  -- 2026-11-10 (evening): the unpriced set is found through edition_fmv_current FIRST (one row
  -- per priced edition; a hash anti-join over ~67k rows), and only its survivors are confirmed
  -- against fmv_snapshots. The old NOT EXISTS read the whole fmv_snapshots_2026 edition index
  -- (2.9M entries, 256k buffers, ~17.6k cold reads = most of a cold run's IO). A lagging
  -- edition_fmv_current only adds survivors that the snapshot check then removes, so the set is
  -- unchanged; an edition_fmv_current row with NO snapshot behind it is excluded (pinned).
  WITH unpriced AS MATERIALIZED (
    SELECT e.id
    FROM public.editions e
    WHERE NOT EXISTS (
        SELECT 1 FROM public.edition_fmv_current c WHERE c.edition_id = e.id
      )
      AND NOT EXISTS (
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

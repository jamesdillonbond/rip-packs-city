-- audit_20260823_ownership_targets_drop_rn1_escape
--
-- ⚠ ALREADY APPLIED from Cowork via the Supabase MCP, 2026-08-23 ~01:35Z.
-- This file is the repo record.
--
-- Retires the `OR o.rn = 1` escape added the previous day in
-- audit_20260822_ownership_backfill_targets_cost_ordering
-- (supabase/migrations/20260823001500_*.sql).
--
-- WHY IT EXISTED: the route treated an EMPTY target list as "no incremental
-- scope" and fell through to an /execute with no query_parameters -- the FULL
-- walk, 876,600 datapoints, 87.7% of the cycle. So this function could not be
-- allowed to return zero rows while uncovered sets remained, even when the
-- cheapest remaining set alone exceeded p_max_datapoints.
--
-- WHY IT GOES NOW: commit 19280e25 makes an empty list a clean skip
-- (`skipped: no_incremental_targets`, ok=true, nothing spent). With that landed
-- the escape became the WORSE branch of the two: it hands back a set larger than
-- the allowance, the walk truncates at the cap, restarts at offset 0 on the next
-- run (the route's own comment flags this), and burns the whole reservation every
-- cycle without ever finishing that set. Base Set S4 alone is 91,979,724
-- datapoints -- 92 cycles -- so this is not hypothetical, only distant.
--
-- ⚠ THE AMBIGUITY THIS CREATES, AND HOW TO RESOLVE IT. A zero-row return now has
-- two meanings and the pipeline_runs skip row cannot tell them apart:
--   (a) the backfill is complete, or
--   (b) the cheapest remaining set costs more than the allowance.
-- Disambiguate with ONE unbounded call:
--     SELECT * FROM public.get_ownership_backfill_targets(1);
--   returns a row -> case (b); read est_datapoints for what it would cost.
--   returns nothing -> case (a), genuinely done.
-- This is written into the function COMMENT so it travels with the object.
--
-- VERIFIED LIVE after applying (2026-08-23):
--   get_ownership_backfill_targets(10, 900000) -> 10 rows / 1,656 dp  (UNCHANGED)
--   get_ownership_backfill_targets(10, 1)      -> 0 rows              (was 1)
--   get_ownership_backfill_targets(1)          -> 1 row, 6 dp         (disambiguator)
-- No behaviour change at any batch size the route uses (default 10, max 50):
-- with p_max_datapoints = 900,000 the 88 cheapest sets already fit. The only call
-- whose result changes is one whose bound is below the cheapest single set.
-- CREATE OR REPLACE preserved the ACL -- re-verified postgres + service_role only,
-- no anon/authenticated.
--
-- REVERT: re-apply supabase/migrations/20260823001500_*.sql verbatim, which
-- restores the escape.

CREATE OR REPLACE FUNCTION public.get_ownership_backfill_targets(
  p_limit           integer,
  p_max_datapoints  bigint DEFAULT NULL
)
RETURNS TABLE(
  set_id_onchain         integer,
  set_name               text,
  series                 smallint,
  uncovered_editions     integer,
  uncovered_moments_est  bigint,
  set_moments_est        bigint,
  est_datapoints         bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH covered AS (
    SELECT DISTINCT edition_external_id FROM public.topshot_ownership
  ),
  base AS (
    SELECT e.set_id_onchain, e.set_name, e.series, e.external_id,
           COALESCE(e.circulation_count, 0) AS cc
    FROM public.editions e
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.external_id ~ '^[0-9]+:[0-9]+$'
      AND e.set_id_onchain IS NOT NULL
  ),
  agg AS (
    SELECT b.set_id_onchain,
           max(b.set_name) AS set_name,
           max(b.series)   AS series,
           count(*) FILTER (WHERE c.edition_external_id IS NULL)::int                     AS uncovered_editions,
           COALESCE(sum(b.cc) FILTER (WHERE c.edition_external_id IS NULL), 0)::bigint    AS uncovered_moments_est,
           COALESCE(sum(b.cc), 0)::bigint                                                  AS set_moments_est
    FROM base b
    LEFT JOIN covered c ON c.edition_external_id = b.external_id
    GROUP BY b.set_id_onchain
    HAVING count(*) FILTER (WHERE c.edition_external_id IS NULL) > 0
  ),
  ord AS (
    SELECT a.*,
           (a.set_moments_est * 6)::bigint       AS est_datapoints,
           row_number() OVER w                   AS rn,
           sum(a.set_moments_est * 6) OVER w     AS cum_dp
    FROM agg a
    WINDOW w AS (
      ORDER BY a.set_moments_est ASC, a.set_id_onchain ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
  )
  SELECT o.set_id_onchain, o.set_name, o.series, o.uncovered_editions,
         o.uncovered_moments_est, o.set_moments_est, o.est_datapoints
  FROM ord o
  WHERE o.rn <= greatest(1, least(p_limit, 250))
    AND (p_max_datapoints IS NULL OR o.cum_dp <= p_max_datapoints)
  ORDER BY o.rn;
$fn$;

COMMENT ON FUNCTION public.get_ownership_backfill_targets(integer, bigint) IS
'Cheapest-first uncovered TopShot sets for the Dune ownership incremental lane. Cost = set_moments_est * 6 (the Dune query returns EVERY moment in a named set, not just the uncovered editions) -- the 2026-08-22 re-ordering on that basis buys 88 sets/cycle instead of 13. p_max_datapoints bounds the CUMULATIVE estimate and can now return ZERO rows (the rn=1 escape was dropped 2026-08-23 once commit 19280e25 made an empty list a clean skip rather than a full walk). ⚠ A zero-row return is ambiguous: either the backfill is complete, or the cheapest remaining set costs more than the bound. Disambiguate with one unbounded call -- SELECT * FROM get_ownership_backfill_targets(1) -- a row means "cannot afford it" and its est_datapoints is the price; nothing means genuinely done. Sole caller: app/api/cron/sync-topshot-ownership-dune (DUNE_OWNERSHIP_INCREMENTAL).';

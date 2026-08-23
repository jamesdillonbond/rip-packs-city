-- audit_20260822_ownership_backfill_targets_cost_ordering
--
-- ⚠ ALREADY APPLIED — live in the DB as schema_migrations version 20260822233700,
-- applied from Cowork via the Supabase MCP on 2026-08-22. This file is the repo
-- record that was missing: every other migration in the 08-22 Dune family got one
-- and this did not, while the route that DEPENDS on its new signature is committed
-- (19280e25 passes p_max_datapoints). Rebuilding from supabase/migrations without
-- this file yields the old 1-arg function, the route's rpc() call fails to resolve,
-- the incremental branch's catch swallows it, and the lane silently never advances.
-- Do NOT re-apply expecting a change; it is idempotent in effect but will re-DROP
-- and re-CREATE.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- get_ownership_backfill_targets ordered by `series DESC, uncovered_moments ASC`.
-- Both keys are wrong.
--
-- The Dune ownership query (7899011) filters `mint` by `setID IN ({{set_ids}})`
-- and scopes `dep` to that mint set, so a run's datapoint cost is the TOTAL
-- circulation of every set named, not the uncovered part of it. The old ordering
-- therefore optimised a quantity that is not the price. And the series-first key
-- forced the walk to finish a whole series -- including that series' Base Set --
-- before touching cheaper sets anywhere else.
--
-- MEASURED against the same 900,000-datapoint reservation:
--     ordering                            1 cycle            12 cycles
--     series DESC, uncovered ASC (old)    13 sets /  148 ed   17 sets /  370 ed
--     set-total cost ASC        (new)     88 sets / 1322 ed  170 sets / 3537 ed
-- 8.9x more editions in the first cycle, 9.6x over a year, same spend.
-- Verified live: get_ownership_backfill_targets(250, 900000) = 88 sets / 893,286 dp;
-- the default batch of 10 costs 1,656 dp against the old batch's 193,542.
--
-- Context neither ordering escapes: all 227 uncovered sets are 311,229,744
-- datapoints (~311 free cycles ~ 26 years), and the single largest set
-- (Base Set S4) is 91,979,724 on its own. This lane cannot finish the catalogue
-- on the free tier; the ordering decides how much of the cheap 96% it reaches
-- before it stalls.
--
-- ⚠ uncovered_moments_est / set_moments_est are sums of editions.circulation_count
-- -- a CATALOGUE estimate, not a Dune row count. True cost is >= them, because the
-- query also re-fetches already-covered editions inside a named set.
--
-- ⚠ The `rn = 1` escape in the WHERE clause was deliberate WHEN WRITTEN: the route
-- then treated an EMPTY target list as "no incremental scope" and fell back to a
-- FULL WALK (876,600 datapoints), so this function had to never return zero rows
-- while uncovered sets remained -- even when the cheapest remaining set alone
-- exceeded p_max_datapoints. Commit 19280e25 has since made an empty list a clean
-- skip (`skipped: no_incremental_targets`), so the escape is now the WORSE branch:
-- it hands back a set larger than the allowance, the walk truncates, restarts at
-- offset 0 next run, and burns the reservation forever. Dropping `OR o.rn = 1` is
-- now safe and is the recommended follow-up -- deferred only because the skip row
-- cannot distinguish "backfill complete" from "cannot afford the next set", and
-- that ambiguity is a reader's problem worth solving in the same change.
--
-- REVERT: restore the 5-column single-argument definition --
--   DROP FUNCTION public.get_ownership_backfill_targets(integer, bigint);
--   then CREATE the prior version, whose body is the same CTEs without
--   set_moments_est / est_datapoints / ord, ending in
--   ORDER BY max(series) DESC NULLS LAST, coalesce(sum(circulation_count),0) ASC
--   LIMIT greatest(1, least(p_limit, 250));
--   and re-apply the same REVOKE/GRANT block for (integer).

DROP FUNCTION IF EXISTS public.get_ownership_backfill_targets(integer);

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
    AND (p_max_datapoints IS NULL OR o.cum_dp <= p_max_datapoints OR o.rn = 1)
  ORDER BY o.rn;
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_ownership_backfill_targets(integer, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_ownership_backfill_targets(integer, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_ownership_backfill_targets(integer, bigint) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_ownership_backfill_targets(integer, bigint) TO postgres, service_role;

COMMENT ON FUNCTION public.get_ownership_backfill_targets(integer, bigint) IS
'Cheapest-first uncovered TopShot sets for the Dune ownership incremental lane. Cost = set_moments_est * 6 (the Dune query returns EVERY moment in a named set, not just the uncovered editions) -- 2026-08-22 re-ordering on that basis buys 88 sets/cycle instead of 13. p_max_datapoints bounds the cumulative cost; the cheapest set is always returned even if it alone exceeds the bound, because the route full-walks on an empty list. Sole caller: app/api/cron/sync-topshot-ownership-dune (DUNE_OWNERSHIP_INCREMENTAL).';

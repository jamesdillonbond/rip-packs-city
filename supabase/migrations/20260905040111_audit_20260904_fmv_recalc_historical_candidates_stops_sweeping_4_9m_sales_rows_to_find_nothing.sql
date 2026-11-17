-- audit_20260904 · fmv-recalc Step 5b: the selective filter runs FIRST, and the
-- step stops being killed by the 30 s service_role statement_timeout
--
-- THE DEFECT, which was recorded honestly and never acted on.
-- `pipeline_runs.extra->>'historical_fallback_error'` over the trailing 73 h:
-- **38 of 459 runs (8.3%) died on `canceling statement due to statement
-- timeout`** -- first 2026-09-02 03:28Z, last 2026-09-05 01:08Z, spread evenly
-- across the window. Not a spike; the steady state. The `_error` key that makes
-- this visible was added 2026-08-31 (a count of 0 could not be told apart from a
-- step that never ran); this is that instrument paying off.
--
-- ⚠ AND THE STEP IS PRODUCTIVE, so this is a repair, not a retirement. Over the
-- same 459 runs it wrote **1,383 rows across 110 runs (24%)**. ⛔ A single
-- EXPLAIN returning 0 rows is NOT evidence the step is dead -- my first reading
-- of this query was exactly that, and the 73 h distribution refuted it. One
-- snapshot is not a distribution.
--
-- THE CAUSE: the conjunction was evaluated in the worst possible order.
-- `EXISTS (SELECT 1 FROM sales WHERE edition_id = e.id AND price_usd > 0)` is
-- NOT selective -- 18,946 of 26,722 editions (71%) have a paid sale -- and the
-- planner ran it FIRST, as a Merge Semi Join that scans **4,866,318 sales rows**
-- across all 8 partitions. The genuinely selective predicate (latest snapshot
-- missing / NO_DATA / older than 7 days) then removed every surviving row.
--
-- MEASURED, warm, same session, buffers not timings (database.md):
--
--   current (planner's order)              513,102 buffers   21,113 ms
--   CTE without MATERIALIZED               513,184 buffers   17,202 ms
--   CTE with MATERIALIZED (this function)  306,847 buffers    9,061 ms
--
-- ⚠ **MATERIALIZED is the load-bearing keyword, not the CTE.** Without it the
-- planner inlines `stale` straight back into the outer query and re-derives the
-- identical bad plan -- measured above at 513,184 buffers, i.e. no change at
-- all. Do not "tidy" it away.
--
-- −40% buffers, −57% time. ⭐ And the gain is LARGER on the 24% of runs that do
-- work, not smaller: the 4.87M-row Merge Append is paid in full regardless of
-- how few rows the LIMIT wants, whereas the per-row index-only probe below can
-- stop as soon as 200 candidates are found.
--
-- ⚠ EQUIVALENCE. Reordering a conjunction cannot change the result set; the only
-- thing that could is WHERE the LIMIT sits. It sits where it did: **after** the
-- EXISTS, never before it. That ordering is load-bearing and the route's own
-- header says why -- 4,294 of 8,571 qualifying editions have no paid sales at
-- all, and if they could enter the bounded candidate set they would occupy the
-- head of an unordered LIMIT forever while the convertible ones were never
-- reached. Preserved exactly. Proven live on a NON-EMPTY population (staleness
-- relaxed to 1 day so 5,060 editions qualify): both orders return 5,060 rows,
-- EXCEPT ALL is empty in both directions.
--
-- THE TIMEOUT, fixed the way its sibling was. `fmv_recalc_edition_page`
-- (2026-07-11) is the same story -- a scan crossing 30 s under cold cache,
-- surfacing as intermittent statement timeouts -- and was fixed by moving it
-- into a SECURITY DEFINER function with a function-local statement_timeout.
--
-- ⚠ 60s, NOT the sibling's 120s, and the difference is deliberate. CLAUDE.md's
-- measured result is that a function-local timeout RAISES the PostgREST path
-- (30 -> 60 s, verified; lower is inert), and that the Supabase gateway hard-caps
-- that path at ~120 s. Declaring 120 s sits exactly on the cap, where an overrun
-- returns `504 upstream request timeout` -- a gateway error that says nothing
-- about which statement was slow -- instead of a clean, attributable
-- `canceling statement due to statement timeout`. 60 s is the measured-working
-- value, 6x the observed 9 s cost, and it fails legibly. It is also well inside
-- the route's maxDuration = 300 with STEP1A/1B already budgeted at 90 s + 120 s.

CREATE OR REPLACE FUNCTION public.fmv_recalc_historical_candidates(
  p_pinnacle_collection_id uuid,
  p_stale_after interval DEFAULT '7 days',
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  edition_id      uuid,
  collection_id   uuid,
  avg_price       numeric,
  min_price       numeric,
  sales_count     bigint,
  latest_sold_at  timestamptz,
  prev_confidence text,
  low_ask         numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout TO '60s'
SET search_path TO 'public'
AS $function$
  WITH stale AS MATERIALIZED (
    -- The SELECTIVE half, alone. 7,224 of 26,722 survive here today.
    SELECT e.id, e.collection_id, e.external_id, la.confidence::text AS prev_confidence
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fs.edition_id, fs.confidence, fs.computed_at
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) la ON true
    WHERE (la.edition_id IS NULL
           OR la.confidence = 'NO_DATA'
           OR la.computed_at < now() - p_stale_after)
      AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
      AND e.collection_id <> p_pinnacle_collection_id
  ),
  cand AS (
    -- The non-selective half, now paid only for survivors -- and the LIMIT stays
    -- AFTER it, so zero-paid-sale editions can never squat the candidate set.
    SELECT s.id, s.collection_id, s.external_id, s.prev_confidence
    FROM stale s
    WHERE EXISTS (
      SELECT 1 FROM sales sa WHERE sa.edition_id = s.id AND sa.price_usd > 0
    )
    LIMIT p_limit
  )
  SELECT
    c.id,
    c.collection_id,
    AVG(s.price_usd)::numeric,
    MIN(s.price_usd)::numeric,
    COUNT(s.id),
    MAX(s.sold_at),
    MAX(c.prev_confidence),
    MAX(be.low_ask) FILTER (WHERE be.low_ask > 0 AND be.low_ask <= 10000)
  FROM cand c
  JOIN sales s ON s.edition_id = c.id
  LEFT JOIN badge_editions be
    ON be.external_id = c.external_id AND be.collection_id = c.collection_id
  WHERE s.price_usd > 0
  GROUP BY c.id, c.collection_id;
$function$;

-- Same exec surface as its siblings fmv_recalc_edition_page and
-- fmv_recalc_uncovered_editions: service_role only. Revoked in ONE statement --
-- this DB carries both a PUBLIC default and an ALTER DEFAULT PRIVILEGES grant.
REVOKE ALL ON FUNCTION public.fmv_recalc_historical_candidates(uuid, interval, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_recalc_historical_candidates(uuid, interval, integer)
  TO service_role;

COMMENT ON FUNCTION public.fmv_recalc_historical_candidates(uuid, interval, integer) IS
  'fmv-recalc Step 5b candidates. Evaluates the SELECTIVE snapshot-staleness '
  'filter before the non-selective EXISTS-over-sales, which the planner otherwise '
  'runs first as a 4.87M-row merge semi join (513,102 -> 306,847 buffers, '
  '21,113 -> 9,061 ms, measured 2026-09-04). MATERIALIZED is required: without it '
  'the planner re-inlines and the bad plan returns unchanged. statement_timeout '
  '60s fixes 38-of-459 runs dying on the 30s service_role limit; 60 not 120 so an '
  'overrun is a legible statement timeout rather than a gateway 504. The LIMIT '
  'must stay AFTER the EXISTS -- see the function body.';

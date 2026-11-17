-- audit_20260904 · fmv-recalc Step 5 stops walking the same anti-join twice
--
-- WHY
-- `query_sql` is the database's #1 reader (inbox 2026-09-04T0500Z: 11.9M blocks
-- over 24 h, 3.4x the next statement) and it is invisible by construction --
-- `pg_stat_statements.track = top` with ZERO non-toplevel rows (re-verified
-- 2026-09-04), so every ad-hoc query through the wrapper collapses into one
-- queryid whose text is `%s`. fmv-recalc owns ~7 of those calls per run at 151
-- runs/day.
--
-- Step 5 ("backfill editions with zero FMV coverage") sent TWO of them, and both
-- walk the SAME anti-join over `editions` x `fmv_snapshots`:
--
--   scan 1  COUNT(*) of editions with no snapshot  -- 101,407 buffers, 2,234 ms
--   scan 2  the same anti-join + badge_editions    -- 106,598 buffers,   770 ms
--                                                     ---------------
--                                                     208,005 buffers/tick
--
-- ⚠ scan 1's ONLY consumer is a console.log. It is not read by an alarm, a
-- threshold or the route's response -- 101,407 buffers, 151 times a day, for one
-- line in a Vercel log. That is what made merging obviously right rather than a
-- judgement call.
--
-- MEASURED, all three shapes on the same warm cache (BUFFERS, not timings --
-- database.md; buffer COUNTS are cache-state-independent, only the hit/read
-- split moves):
--
--   scan 1 + scan 2   208,005 buffers
--   this function     101,725 buffers    -51.1%
--
-- The win is not the count: it is that the badge join stops driving the
-- anti-join. Today `badge_editions` (17,592 in-range rows) is the outer side and
-- feeds 17,108 probes into fmv_snapshots_2026 -- 38,362 buffers of merge join
-- plus 66,071 of probing. Here the anti-join runs ONCE, materialised, and the
-- 171 survivors drive an index scan into badge_editions for **342 buffers**.
--
-- ⚠ NOT A RETIREMENT. The step is rare but REAL: over the trailing 73 h it
-- converted 42 rows in ONE of 460 runs (pipeline_runs.extra->>'backfill'), and
-- the other 459 returned zero. It is kept, in full, at half the cost.
--
-- ⚠ Why scoping by `editions.created_at` was considered and REJECTED (it would
-- have been much cheaper and it is WRONG): the currently-missing population is
-- 171 rows, all nba_top_shot, created 2026-06-21..2026-08-20 -- **none in the
-- last 7 days** -- yet 42 converted on 09-04. Editions do not enter this set by
-- being created; they LEAVE it when a `badge_editions` row arrives for an
-- edition that was already missing. A created_at scope would therefore drop
-- exactly the conversions the step exists to make. Scoping an aggregate is an
-- equivalence claim, and this one does not hold.
--
-- EQUIVALENCE with the two queries it replaces:
--   * `LEFT JOIN fmv_snapshots ... WHERE fs.edition_id IS NULL` == `NOT EXISTS`.
--   * `LEFT JOIN badge_editions ... WHERE be.low_ask IS NOT NULL` is an inner
--     join with that filter; join shape, and therefore duplicate multiplicity,
--     is unchanged.
--   * LIMIT still applies after every filter.
--   * The one behavioural difference: the anti-join is always walked in full
--     (it must be, to answer the census) rather than short-circuiting once
--     p_limit candidates are found. That cannot cost more than the PAIR, because
--     scan 1 already walked it in full on every tick.
--
-- ⚠ The census is returned even when there are NO candidates. A bare row set
-- cannot carry it -- zero rows would conflate "no candidates" with "the read
-- failed", which is the three-states rule -- so the return is jsonb with the
-- census and the candidate array as separate keys.

CREATE OR REPLACE FUNCTION public.fmv_recalc_uncovered_editions(
  p_pinnacle_collection_id uuid,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout TO '120s'
SET search_path TO 'public'
AS $function$
  WITH missing AS MATERIALIZED (
    SELECT e.id, e.external_id, e.collection_id
    FROM editions e
    WHERE NOT EXISTS (
            SELECT 1 FROM fmv_snapshots fs WHERE fs.edition_id = e.id
          )
      AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
      AND e.collection_id <> p_pinnacle_collection_id
  ),
  cands AS (
    SELECT m.id AS edition_id, m.collection_id, be.low_ask
    FROM missing m
    JOIN badge_editions be
      ON be.external_id = m.external_id
     AND be.collection_id = m.collection_id
    WHERE be.low_ask IS NOT NULL
      AND be.low_ask > 0
      AND be.low_ask <= 10000
    LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'missing_total', (SELECT count(*) FROM missing),
    'candidates',    COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM cands c), '[]'::jsonb)
  );
$function$;

-- Same exec surface as its sibling fmv_recalc_edition_page: service_role only.
-- Revoked in ONE statement -- this DB carries both a PUBLIC default and an
-- ALTER DEFAULT PRIVILEGES grant, so revoking either half alone leaves the other.
REVOKE ALL ON FUNCTION public.fmv_recalc_uncovered_editions(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_recalc_uncovered_editions(uuid, integer)
  TO service_role;

COMMENT ON FUNCTION public.fmv_recalc_uncovered_editions(uuid, integer) IS
  'fmv-recalc Step 5. Returns {missing_total, candidates[]} from ONE materialised '
  'anti-join over editions x fmv_snapshots, replacing two separate query_sql scans '
  '(208,005 -> 101,725 buffers/tick, measured 2026-09-04). Own queryid, so its cost '
  'is attributable -- the query_sql wrapper collapses every caller into one row. '
  'Do NOT scope by editions.created_at: rows leave this set when a badge_editions '
  'row arrives, not when an edition is created (inbox 2026-09-04T0500Z).';

-- audit_20260905_pack_ev_latest_stops_probing_pack_ask_state_once_per_history_row
--
-- 🚨 THE DEFECT. `pack_ev_latest` filtered with a CORRELATED `EXISTS` against
-- `pack_ask_state`, evaluated once per `pack_ev_history` row -- BEFORE the
-- `DISTINCT ON` cuts 314,130 rows down to 4,642. Measured 2026-09-05:
--
--     SubPlan 3 -> Index Scan pack_ask_state_pkey
--         loops = 128,911      buffers = 382,519      rows = 0 on every loop
--
-- **382,519 buffers -- 54% of the whole query -- to return zero rows 128,911
-- times.** `pack_ask_state` holds 3,028 rows total; the same dist_id was probed
-- thousands of times over.
--
-- ── WHY IT MATTERED NOW, AND NOT AS A CRON COST ───────────────────────────────
-- Two PUBLIC routes started crossing their 8,000 ms `boundedRead` bound, and both
-- are >99.7% this view: `v_topshot_pack_reality_ranker_staleness` on
-- /api/public/insights/pack-reality (first 2026-09-04 16:38Z) and
-- `v_topshot_pack_ev_calibrated` on /api/packs (first 2026-09-05 06:17Z).
-- 706k buffers to answer a question whose answer is THREE ROWS.
--
-- ⚠ `public_board_slow_count` read CLEAN throughout. Vercel runtime logs were the
-- only instrument that saw it, exactly as the night-pass skill says.
--
-- ── THE REWRITE ───────────────────────────────────────────────────────────────
-- The correlated EXISTS becomes a LEFT JOIN. **This is only sound because
-- `pack_ask_state_pkey` is UNIQUE on (collection_slug, dist_id)** -- checked, not
-- assumed -- so at most one row can match and the join cannot multiply rows.
--
--     EXISTS (... AND h.gross_ev > 3 * a.lowest_ask)
--       ==  a.dist_id IS NOT NULL AND h.gross_ev > 3 * a.lowest_ask     (unique key)
--
-- ⚠ THE `COALESCE` IS LOAD-BEARING AND IS NOT DECORATION. Without it the two
-- forms DIFFER on a NULL `gross_ev`: the EXISTS subquery returns no rows, so
-- `NOT(true AND false)` = true and the row is KEPT; the join form yields
-- `NOT(true AND NULL)` = NULL, and WHERE DROPS the row. `pack_ev_history` has
-- **0 NULL gross_ev across 320,171 rows today**, so this is a guard against a
-- future NULL rather than a live fix -- but it is the difference between a
-- rewrite that is equivalent and one that is equivalent *by luck*.
--
-- ⛔ WHAT WAS DELIBERATELY **NOT** DONE: the filters are still applied BEFORE the
-- `DISTINCT ON`, exactly as before. Moving them after would be a SEMANTIC change,
-- not an optimisation -- filter-then-distinct keeps the newest row *that
-- qualifies*, while distinct-then-filter would drop a pack_listing_id entirely
-- whenever its newest row fails the predicate but an older one passes. 68
-- dependent views ride on the current meaning.
--
-- ── MEASURED (warm, same session) ─────────────────────────────────────────────
--   SELECT * FROM pack_ev_latest        707,048 -> 10,898 shared buffers  (65x)
--                                         2,762 -> 1,549 ms
--   v_topshot_pack_reality_ranker_...   705,997 -> 10,907  (65x)   rows 3 -> 3
--   v_topshot_pack_ev_calibrated        707,584 -> 12,618  (56x)   rows 810 -> 810
--
-- ⚠ THE HONEST COST, STATED RATHER THAN BURIED: the plan trades an index-ordered
-- scan for a Seq Scan + **external merge sort spilling ~28-49 MB to temp** per
-- execution, because the hash join destroys the index ordering the DISTINCT ON
-- was riding. Total I/O still falls ~30x (707k shared vs ~11k shared + ~12k temp
-- blocks). Sized before shipping: `pg_stat_statements` shows this view's callers
-- are the jobid-73 refresher (48/day) plus low-volume routes -- **tens of calls
-- per hour, not thousands** -- so a per-execution spill is not a concurrency
-- hazard here. It would become one if a high-frequency caller were added, and it
-- shrinks to nothing if work_mem is ever raised.
-- ⚠ Warm milliseconds barely moved on the ranker (1,320 -> 1,319). **The win is
-- BUFFERS, which is what governs the COLD path** -- and cold is where the 8 s
-- bound was being crossed (a cold read measured 7,441 ms pre-change).
--
-- ✅ EQUIVALENCE PROVEN OVER THE POPULATION, BOTH DIRECTIONS, BEFORE APPLYING:
--     live 4,642 rows | candidate 4,642 rows
--     live EXCEPT candidate = 0     candidate EXCEPT live = 0     INTERSECT = 4,642
--   Same ROWS, not merely the same count.
--
-- ✅ POST-APPLY, CONFIRMED FROM OUTSIDE: pack_ev_latest 4,642;
--   v_topshot_pack_ev_calibrated 810; ranker qualifying = 3; v_topshot_pack_market
--   1,842. `reloptions` still NULL -- this view has NEVER carried
--   `security_invoker`, and this migration deliberately does NOT add it (that
--   would be a behaviour change on a view with 68 dependents, not a tidy-up).
--   CREATE OR REPLACE VIEW keeps the column list, so no dependent was dropped and
--   no ACL was touched.
--
-- Live viewdef fingerprint after this migration: md5 70c6b1800c8ea7542c470034f37cd0d2 (2,945 chars).
--
-- anon-exec: n/a -- no function is created or replaced.
--
-- REVERT: restore the previous definition from this file's git history. It is the
-- same SELECT with the LEFT JOIN removed and this predicate put back:
--   AND NOT (collection_id = '95f28a17-...'::uuid AND EXISTS (
--     SELECT 1 FROM pack_ask_state a WHERE a.collection_slug = 'nba-top-shot'
--       AND a.dist_id = h.dist_id AND a.is_listed IS TRUE AND a.lowest_ask > 0
--       AND h.gross_ev > 3 * a.lowest_ask))
-- A revert is a plain CREATE OR REPLACE VIEW -- no drop, no cascade.

CREATE OR REPLACE VIEW public.pack_ev_latest AS
 SELECT DISTINCT ON (h.pack_listing_id) h.pack_listing_id,
    h.collection_id,
    h.dist_id,
    h.pack_name,
        CASE
            WHEN h.pack_price > 0::numeric AND h.pack_price < 9999::numeric THEN h.pack_price
            ELSE NULL::numeric
        END::numeric(10,2) AS pack_price,
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::numeric
            ELSE h.gross_ev
        END::numeric(10,2) AS gross_ev,
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::numeric
            WHEN NOT (h.pack_price > 0::numeric AND h.pack_price < 9999::numeric) THEN NULL::numeric
            ELSE h.pack_ev
        END::numeric(10,2) AS pack_ev,
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::boolean
            WHEN NOT (h.pack_price > 0::numeric AND h.pack_price < 9999::numeric) THEN NULL::boolean
            WHEN h.total_unopened IS NOT NULL AND h.total_unopened <= 0 OR h.depletion_pct IS NOT NULL AND h.depletion_pct >= 100 THEN false
            ELSE h.is_positive_ev
        END AS is_positive_ev,
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::numeric
            WHEN NOT (h.pack_price > 0::numeric AND h.pack_price < 9999::numeric) THEN NULL::numeric
            ELSE h.value_ratio
        END::numeric(12,4) AS value_ratio,
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::smallint
            ELSE h.fmv_coverage_pct
        END AS fmv_coverage_pct,
    h.edition_count,
    h.total_unopened,
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::smallint
            ELSE h.depletion_pct
        END AS depletion_pct,
    h.snapshotted_at,
    h.primary_price,
    h.secondary_ask,
    h.price_source,
    h.primary_available,
    h.secondary_available,
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::numeric
            ELSE h.typical_ev
        END::numeric(10,2) AS typical_ev
   FROM pack_ev_history h
   LEFT JOIN pack_ask_state a
     ON a.collection_slug = 'nba-top-shot'::text
    AND a.dist_id = h.dist_id
    AND a.is_listed IS TRUE
    AND a.lowest_ask > 0::numeric
  WHERE h.pack_ev >= '-10000'::integer::numeric
    AND h.pack_ev <= 1000000::numeric
    AND h.pack_name !~~ 'Holding %'::text
    AND (h.pack_price > 0::numeric AND h.pack_price < 9999::numeric
         OR (h.pack_price IS NULL OR h.pack_price <= 0::numeric OR h.pack_price >= 9999::numeric)
            AND NOT (EXISTS ( SELECT 1
                   FROM pack_distributions pd
                  WHERE pd.dist_id = h.dist_id AND pd.collection_id = h.collection_id AND (pd.metadata ->> 'retail_price_usd'::text) IS NOT NULL)))
    AND NOT (h.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
             AND a.dist_id IS NOT NULL
             AND COALESCE(h.gross_ev > 3::numeric * a.lowest_ask, false))
  ORDER BY h.pack_listing_id, h.snapshotted_at DESC;

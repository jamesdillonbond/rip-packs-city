-- audit_20260831_editions_two_indexes_the_edition_page_family_seq_scanned_editions_twice_per_call
--
-- WHY: on the pg_stat_statements DIFF over 2026-08-31 22:20:41Z -> 23:00:14Z, joined on
-- (userid, dbid, toplevel, queryid), the two largest CONTINUOUS production readers were
--     get_edition_recent_sales   276 calls  1,255,703 buffers  (4,550/call)  23.6 s
--     get_edition_market_bundle  138 calls  1,137,554 buffers  (8,243/call)  13.6 s
-- and get_moment_detail 82 calls / 400,453 buffers (4,884/call) close behind. `editions` is
-- 27,341 rows in 3,921 pages / 31 MB, and the per-call figures are ~1x and ~2x that page count.
-- They were, in the plan, exactly that: seq scans of the whole `editions` table, one or two per
-- call, on every edition- and moment-detail page view.
--
-- TWO INDEPENDENT CAUSES, both in the SAME table, found by reading the generic plan of the
-- ELSE branch of get_edition_recent_sales through a 4-parameter PREPARE (6 executes, so the
-- plan is generic like plpgsql's), NOT the body with literals:
--
--   (1) `sub_names` -- `SELECT DISTINCT ON (subedition_id) subedition_id, subedition_name
--       FROM editions WHERE subedition_id IS NOT NULL AND subedition_name IS NOT NULL
--       ORDER BY subedition_id` -- a Seq Scan + Sort over 27,341 rows, "Rows Removed by
--       Filter: 23,504", to produce TWENTY-ONE rows, once per call. Carried byte-identically
--       by get_edition_recent_sales AND get_moment_detail (found by grepping pg_proc.prosrc
--       for the EXPRESSION, not the file -- ledger 2026-08-29, the sixth instance of that rule).
--
--   (2) the `ed` CTE -- `WHERE collection_id = $1 AND (external_id = $2 OR id::text = $2)`.
--       The OR's second arm is a CAST of the primary key, which no index covered, so the whole
--       disjunction fell back to a Seq Scan even though the first arm is served by the unique
--       index editions_external_id_collection_id_key. Carried by FIVE functions:
--       get_edition_detail, get_edition_fmv_history, get_edition_in_packs,
--       get_edition_recent_sales, get_edition_sale_history.
--
-- MEASURED 2026-08-31 23:1xZ, EXPLAIN (ANALYZE, BUFFERS) THROUGH THE FUNCTION (not the body),
-- every reading warmed twice first, and -- this is the part that makes it a fair test -- the
-- BASELINE RE-TAKEN IN THE SAME STATE as the candidate by DROPping the index CONCURRENTLY,
-- re-measuring, and rebuilding. VACUUM (ANALYZE) public.editions was run BEFORE all of these
-- readings, so it is not a hidden variable on either side (it was needed: the first index-only
-- scan reported Heap Fetches 1,282 against a stale visibility map, which is the whole
-- difference between 1,111 buffers and 16).
--
--   isolated sub_names cursor      3,924 buffers / 40.4 ms  ->      16 buffers / 4.5 ms  (245x)
--   isolated `ed` CTE              3,003 buffers            ->       7 buffers            (429x)
--   get_edition_detail             2,976 buffers / 13.3 ms  ->      30 buffers / 4.1 ms   (99x)
--   get_edition_in_packs           2,994 buffers / 10.1 ms  ->      48 buffers / 0.9 ms   (62x)
--   get_edition_recent_sales       7,682 buffers / 26.0 ms  ->     811 buffers / 4.1 ms   (9.5x)
--   get_moment_detail              4,737 buffers / 22.3 ms  ->     862 buffers / 10.1 ms  (5.5x)
--
-- These are PLAN changes -- Seq Scan -> Index Only Scan, and Seq Scan -> BitmapOr over
-- (editions_external_id_collection_id_key, idx_editions_id_text) -- both read off EXPLAIN, so
-- no warm cache can fake them. Row counts are unchanged by construction: an index add cannot
-- alter a result set, and every reading above returned the same rows.
--
-- Post-ship, same session, for the two functions whose pre-index baseline was not taken and
-- which are therefore reported as one-sided readings, not as ratios:
--   get_edition_sale_history 211 buffers / 1.5 ms · get_edition_fmv_history 47 buffers / 1.0 ms
--
-- COST: 48 kB + 1,600 kB = 1,648 kB of new index on a 31 MB / 77 MB table. `editions` is
-- written by the catalog walks, not by user traffic; two more small btrees on a 27 k-row table
-- is not a write-path concern at this size.
--
-- WHAT WAS DONE LIVE (this file records it; on prod both statements below are no-ops): both
-- indexes were built with CREATE INDEX CONCURRENTLY as postgres (the table owner; cron_heavy
-- cannot CREATE INDEX) at 2026-08-31 23:1x-23:2xZ. Verified after the build: indisvalid =
-- indisready = true on both, ZERO invalid indexes on public.editions, and zero leftover
-- tmp_probe% relations (idx_editions_id_text was first built under the throwaway name
-- tmp_probe_editions_id_text purely so it could be dropped again for the same-state baseline;
-- that probe was dropped before the final build). On a fresh database this file builds them
-- plainly.
-- anon-exec: none (no function created or replaced; no ACL touched).
--
-- ⚠ NOT DONE HERE, ON PURPOSE. The honest fix for cause (2) is in the five function bodies --
-- `id::text = p_route_slug` should be `(p_route_slug ~ '^[0-9a-f-]{36}$' AND id =
-- p_route_slug::uuid)`, which needs no expression index at all. That is five CREATE OR REPLACEs
-- of live public read paths; the index gets the same plan tonight at zero semantic risk, and
-- the body cleanup is filed rather than rushed.
--
-- EXIT / FALSIFIER, derived from the post-fix measurement above and not from a round number:
--   PASS if, on the next pgss diff containing them, get_edition_recent_sales is under
--   2,000 buffers/call (measured 811 through the function; production calls carry other
--   collections and offsets) and get_moment_detail is under 2,000 buffers/call (measured 862).
--   Both were 4,550 and 4,884 in the 22:20->23:00Z diff that motivated this.
--   FAIL (revert) if either stays above 4,000 buffers/call, or if pg_stat_user_indexes reports
--   idx_scan = 0 on EITHER new index 24 h from now -- an index nothing chooses is the
--   2026-08-31 18:35Z finding repeating itself (a 253 MB index set sat unused behind a
--   NULLS LAST clause), and it should be dropped, not kept "just in case".
--
-- REVERT (either half independently, no dependency between them):
--   DROP INDEX CONCURRENTLY public.idx_editions_subedition_name_lookup;
--   DROP INDEX CONCURRENTLY public.idx_editions_id_text;
-- Nothing else in the database changes; no function, view, ACL or grant is touched by this file.

CREATE INDEX IF NOT EXISTS idx_editions_subedition_name_lookup
  ON public.editions (subedition_id, subedition_name)
  WHERE subedition_id IS NOT NULL AND subedition_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_editions_id_text
  ON public.editions (((id)::text));

-- Post-condition: refuse to book this migration if either index is missing or invalid.
DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname IN ('idx_editions_subedition_name_lookup', 'idx_editions_id_text')
        AND i.indisvalid AND i.indisready) <> 2 THEN
    RAISE EXCEPTION 'both editions indexes must exist, be valid and be ready after this migration';
  END IF;
END
$post$;
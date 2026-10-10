-- audit_20261010_fmv_recalc_edition_page_tiebreaks_on_edition_id   (known-issues #177, part 1)
--
-- MEASURED 2026-10-10 ~3:50 AM PT (Cowork cloud). The fmv-recalc work-list pages editions by
-- `ORDER BY MAX(s.sold_at) DESC NULLS LAST LIMIT/OFFSET` with NO tiebreak. In the live 30-day window
-- 968 of 11,945 editions sit in 640 tie groups (same MAX(sold_at) to the microsecond — batch ingests and
-- Atlas rows share timestamps), so the order inside a tie group is whatever the hash aggregate emitted
-- that tick: a tie group straddling a page boundary can hand the same edition to two ticks and another
-- edition to none. This adds `, s.edition_id` as the second sort key. It sorts rows that are already
-- grouped (one per edition), so the plan is unchanged: raw body EXPLAIN (ANALYZE, BUFFERS) at
-- LIMIT 500 OFFSET 1500 = 12,478 buffers / 69.9 ms with the tiebreak vs the function's 16,682 / 70.1 ms
-- before it (the function figure includes 3,584 planning buffers); same Index Only Scan on
-- idx_sales_2026_fmv_recalc_window, same HashAggregate, top-N heapsort 333 kB.
--
-- NOT fixed here (#177 part 2): a new sale moves its edition to the front between ticks, so an OFFSET
-- cursor still skips the edition that slides across a page boundary; that needs keyset paging in the
-- route and is Claude Code's. A skipped edition is re-priced on the next sweep (delay, not corruption).
--
-- Pin: supabase/tests/fmv_recalc_edition_page.sql (verbatim block re-pinned to this file; claim 6 plants
-- two editions tied on MAX(sold_at) and asserts the lower uuid pages first).
-- Watch: the next production `fmv-recalc` pipeline_runs row's duration_ms (CLAUDE.md, fifth lie).
--
-- REVERT: re-apply the body from 20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql
--         (ORDER BY MAX(s.sold_at) DESC NULLS LAST, no second key) and re-point the pin.

CREATE OR REPLACE FUNCTION public.fmv_recalc_edition_page(p_window_start timestamp with time zone, p_pinnacle_collection_id uuid, p_limit integer, p_offset integer)
 RETURNS TABLE(edition_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '120s'
 SET search_path TO 'public'
AS $function$
  SELECT s.edition_id
  FROM sales s
  WHERE s.sold_at >= p_window_start
    AND s.price_usd > 0
    AND s.collection_id <> p_pinnacle_collection_id
    AND s.edition_id IS NOT NULL
  GROUP BY s.edition_id
  ORDER BY MAX(s.sold_at) DESC NULLS LAST, s.edition_id
  LIMIT p_limit OFFSET p_offset
$function$;

-- anon-exec: intentional — same signature, ACLs preserved by CREATE OR REPLACE; service_role caller via rpcWithRetry (fmv_recalc_edition_page)

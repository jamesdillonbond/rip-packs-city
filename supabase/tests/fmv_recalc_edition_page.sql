-- DB invariant: public.fmv_recalc_edition_page — the paged edition-selection query
-- that drives the whole fmv-recalc sweep. fmv-recalc reprices exactly the editions
-- this returns, so a regression here silently STOPS repricing some editions (they
-- go stale) or reprices the wrong ones. It is the recency-ordered work-list.
--
-- Pins:
--   * only sales in [p_window_start, ∞) with price_usd > 0 and a non-NULL
--     edition_id count (junk/free/unmapped rows never enter the work-list);
--   * the Pinnacle collection is excluded (it has its own render-keyed pipeline);
--   * one row per edition (GROUP BY), ordered by most-recent sale DESC — the
--     freshest-traded editions get repriced first;
--   * LIMIT/OFFSET paginate deterministically over that ordering.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures (only the columns the function reads) ────────────────────
CREATE TABLE public.sales (
  edition_id uuid, sold_at timestamptz, price_usd numeric, collection_id uuid);

-- >>> BEGIN verbatim fmv_recalc_edition_page (keep byte-identical to the migration) >>>
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
  ORDER BY MAX(s.sold_at) DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset
$function$;
-- <<< END verbatim fmv_recalc_edition_page <<<

\set flow '''11111111-1111-1111-1111-111111111111'''
\set pin  '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set edA  '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set edB  '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set edC  '''cccccccc-cccc-cccc-cccc-cccccccccccc'''
\set edD  '''dddddddd-dddd-dddd-dddd-dddddddddddd'''

-- edA: freshest sale (1 day ago) + an older one -> one grouped row, most recent wins
-- edB: sale 5 days ago (in window)
-- edC: OUT of window (40 days ago) -> excluded
-- edD: in window but price_usd = 0 -> excluded
-- pin-collection sale (in window, priced) -> excluded
-- a NULL-edition sale (in window, priced) -> excluded
INSERT INTO public.sales (edition_id, sold_at, price_usd, collection_id) VALUES
  (:edA::uuid, now() - interval '10 days', 20, :flow::uuid),
  (:edA::uuid, now() - interval '1 day',   25, :flow::uuid),
  (:edB::uuid, now() - interval '5 days',  30, :flow::uuid),
  (:edC::uuid, now() - interval '40 days', 40, :flow::uuid),  -- out of 30d window
  (:edD::uuid, now() - interval '2 days',   0, :flow::uuid),  -- price 0
  (:edD::uuid, now() - interval '2 days',  -5, :flow::uuid),  -- negative
  (NULL,       now() - interval '2 days',  10, :flow::uuid),  -- null edition
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid, now() - interval '2 days', 15, :pin::uuid);  -- pinnacle

\set win '''30 days'''

-- ── 1. window + price + collection + null filters, and grouping (2 editions) ──
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 100, 0)),
  '2', 'only edA + edB survive the window/price/pinnacle/null filters (deduped per edition)');

-- ── 2. recency ordering: edA (1d ago) before edB (5d ago) ─────────────────────
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 100, 0) LIMIT 1),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'freshest-traded edition (edA) is ordered first');

-- ── 3. LIMIT paginates (page size 1 -> just edA) ─────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 1, 0)),
  '1', 'LIMIT 1 returns one edition');

-- ── 4. OFFSET advances to the next page (edB) ────────────────────────────────
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 1, 1) LIMIT 1),
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'OFFSET 1 returns the second page (edB)');

-- ── 5. a tighter window excludes edB too (only edA in last 2 days) ───────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_recalc_edition_page(now() - interval '2 days', :pin::uuid, 100, 0)),
  '1', 'a 2-day window keeps only edA');

SELECT '✓ fmv_recalc_edition_page: all assertions passed' AS result;

ROLLBACK;

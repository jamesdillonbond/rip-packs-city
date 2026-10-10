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
--   * ties on MAX(sold_at) break on edition_id ASC (2026-10-10, #177 part 1), so a tie
--     group straddling a page boundary pages the same way on every tick.
--   * (2026-10-10, #177 part 2) the order is computed at offset 0 and kept: a later
--     page is a slice of that snapshot, so a sale landing mid-sweep cannot shift a
--     later page (7); a snapshot older than 12 h is rebuilt, never served (8).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261010143219_audit_20261010_fmv_recalc_sweep_pages_a_snapshot_of_its_order.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures (only the columns the function reads) ────────────────────
CREATE TABLE public.sales (
  edition_id uuid, sold_at timestamptz, price_usd numeric, collection_id uuid);
CREATE TABLE public.fmv_recalc_sweep_order (
  id smallint PRIMARY KEY CHECK (id = 1), built_at timestamptz NOT NULL,
  pinnacle_collection_id uuid NOT NULL, window_start timestamptz NOT NULL, edition_ids uuid[] NOT NULL);

-- >>> BEGIN verbatim fmv_recalc_edition_page (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.fmv_recalc_edition_page(p_window_start timestamp with time zone, p_pinnacle_collection_id uuid, p_limit integer, p_offset integer)
 RETURNS TABLE(edition_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '120s'
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids uuid[];
BEGIN
  -- a later page of the sweep reads the order the sweep started with
  IF p_offset > 0 THEN
    SELECT o.edition_ids INTO v_ids
      FROM public.fmv_recalc_sweep_order o
     WHERE o.id = 1
       AND o.pinnacle_collection_id = p_pinnacle_collection_id
       AND o.built_at > now() - interval '12 hours';
  END IF;

  -- offset 0, or no usable snapshot: compute the order once and keep it
  IF v_ids IS NULL THEN
    SELECT coalesce(array_agg(x.edition_id ORDER BY x.last_sold DESC NULLS LAST, x.edition_id), '{}'::uuid[])
      INTO v_ids
      FROM (SELECT s.edition_id, MAX(s.sold_at) AS last_sold
              FROM sales s
             WHERE s.sold_at >= p_window_start
               AND s.price_usd > 0
               AND s.collection_id <> p_pinnacle_collection_id
               AND s.edition_id IS NOT NULL
             GROUP BY s.edition_id) x;
    INSERT INTO public.fmv_recalc_sweep_order (id, built_at, pinnacle_collection_id, window_start, edition_ids)
    VALUES (1, now(), p_pinnacle_collection_id, p_window_start, v_ids)
    ON CONFLICT (id) DO UPDATE
      SET built_at = EXCLUDED.built_at,
          pinnacle_collection_id = EXCLUDED.pinnacle_collection_id,
          window_start = EXCLUDED.window_start,
          edition_ids = EXCLUDED.edition_ids;
  END IF;

  RETURN QUERY
    SELECT u.e
      FROM unnest(v_ids[p_offset + 1 : p_offset + p_limit]) WITH ORDINALITY AS u(e, ord)
     ORDER BY u.ord;
END
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

-- ── 6. ties on MAX(sold_at) page deterministically: edition_id ASC inside a tie ─
-- edF and edE both sold at exactly the same instant (fresher than edA); the lower
-- uuid (edE) must come first on every call, and OFFSET 1 must then be edF.
\set edE  '''eeeeeeee-0000-0000-0000-eeeeeeeeeeee'''
\set edF  '''ffffffff-0000-0000-0000-ffffffffffff'''
INSERT INTO public.sales (edition_id, sold_at, price_usd, collection_id) VALUES
  (:edF::uuid, now() - interval '1 hour', 12, :flow::uuid),
  (:edE::uuid, now() - interval '1 hour', 13, :flow::uuid);
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 1, 0)),
  'eeeeeeee-0000-0000-0000-eeeeeeeeeeee', 'inside a MAX(sold_at) tie the lower edition_id pages first');
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 1, 1)),
  'ffffffff-0000-0000-0000-ffffffffffff', 'OFFSET 1 lands on the other tied edition, never a repeat');

-- ── 7. a sale landing mid-sweep cannot shift a later page ─────────────────────
-- Build the sweep at offset 0 (order: edE, edF, edA, edB), then edB sells NOW, which
-- live would move it to the front. Page 2 (offset 1) must still be edF from the
-- snapshot, and page 4 (offset 3) still edB -- nothing skipped, nothing repeated.
SELECT count(*) FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 1, 0);
INSERT INTO public.sales (edition_id, sold_at, price_usd, collection_id) VALUES (:edB::uuid, now(), 31, :flow::uuid);
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 1, 1)),
  'ffffffff-0000-0000-0000-ffffffffffff', 'a mid-sweep sale does not shift page 2: it is still the snapshot''s edF');
SELECT _assert_eq(
  (SELECT string_agg(edition_id::text, ',') FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 10, 1)),
  'ffffffff-0000-0000-0000-ffffffffffff,aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'the rest of the sweep is the snapshot order, each edition once');

-- ── 8. a stale snapshot is rebuilt, never served ─────────────────────────────
UPDATE public.fmv_recalc_sweep_order SET built_at = now() - interval '13 hours';
SELECT _assert_eq(
  (SELECT edition_id::text FROM public.fmv_recalc_edition_page(now() - interval '30 days', :pin::uuid, 1, 1)),
  'eeeeeeee-0000-0000-0000-eeeeeeeeeeee', 'a 13 h-old snapshot is rebuilt: edB now leads, so offset 1 is edE');

SELECT '✓ fmv_recalc_edition_page: all assertions passed' AS result;

ROLLBACK;

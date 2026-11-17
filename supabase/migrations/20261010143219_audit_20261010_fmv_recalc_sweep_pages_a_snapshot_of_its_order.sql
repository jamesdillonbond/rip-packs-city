-- audit_20261010_fmv_recalc_sweep_pages_a_snapshot_of_its_order
-- anon-exec: unchanged (fmv_recalc_edition_page) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=false authenticated=false 2026-10-10.
--
-- 2026-10-10 (known-issues #177 part 2; decided under Trevor's "make decisions yourself").
-- fmv-recalc walks this work-list page by page across ticks with an OFFSET cursor, but the
-- ordering (MAX(sold_at) DESC) moves between ticks: a new sale pulls its edition to the front
-- and shifts every later edition back one place, so the edition sitting at the page boundary is
-- skipped for the whole sweep (and another repeated). And every page re-ran the full 30-day
-- GROUP BY to throw away all but 500 rows: pg_stat_statements 10-10, 9,149 calls at a mean of
-- 5.9 s.
--
-- WHAT. The ordering is computed ONCE per sweep. Offset 0 (and any page whose snapshot is
-- missing, older than 12 h, or built for another Pinnacle id) runs the same aggregate as before
-- and stores the ordered id list in public.fmv_recalc_sweep_order (one row, upserted, no
-- deletes); every later page is a slice of that array. A sweep therefore visits each edition of
-- its snapshot exactly once; an edition first traded mid-sweep is picked up by the next sweep,
-- which is also what OFFSET did for it (it jumped into the already-visited front). Signature and
-- return shape are unchanged, so the route is untouched; the function becomes plpgsql VOLATILE
-- because it writes. Pin claims 7-8 (a mid-sweep sale cannot move a later page; a stale
-- snapshot is rebuilt).
--
-- REVERT: re-apply 20261010101713 (fmv_recalc_edition_page), then
--   DROP TABLE public.fmv_recalc_sweep_order;

CREATE TABLE IF NOT EXISTS public.fmv_recalc_sweep_order (
  id smallint PRIMARY KEY CHECK (id = 1),
  built_at timestamptz NOT NULL,
  pinnacle_collection_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  edition_ids uuid[] NOT NULL);
ALTER TABLE public.fmv_recalc_sweep_order ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmv_recalc_sweep_order FROM PUBLIC, anon, authenticated;

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

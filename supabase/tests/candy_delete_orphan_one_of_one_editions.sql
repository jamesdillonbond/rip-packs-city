-- DB invariant: public.candy_delete_orphan_one_of_one_editions(int) — 2026-11-09.
-- The property: deletes a Candy circulation-1 edition only when NO card holds it, it is older than a
-- day, and no CASCADE / SET NULL table references it; a NO ACTION reference is caught and COUNTED,
-- never forced; other collections, larger editions and fresh rows are never touched; the run log
-- counts rows actually deleted.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261110041400_audit_20261109_candy_trophies_mlb_only_and_orphan_one_of_one_cleanup.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text, circulation_count int, created_at timestamptz);
CREATE TABLE public.wallet_moments_cache (collection_id uuid, edition_key text, moment_id text);
CREATE TABLE public.user_wishlists (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.watchlist_items (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.candy_offers (edition_id uuid REFERENCES public.editions(id) ON DELETE SET NULL);
CREATE TABLE public.pack_drop_pool (edition_id uuid REFERENCES public.editions(id) ON DELETE SET NULL);
CREATE TABLE public.special_serial_holders (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.special_serial_lookup_failures (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.sales (edition_id uuid REFERENCES public.editions(id));   -- NO ACTION
CREATE TABLE public.pipeline_runs_stub (pipeline text, rows_written int, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_rows_written, p_ok, p_extra) RETURNING 1::bigint $$;

-- >>> BEGIN verbatim candy_delete_orphan_one_of_one_editions (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.candy_delete_orphan_one_of_one_editions(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_candy      constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_candidates int := 0;
  v_deleted    int := 0;
  v_referenced int := 0;
  r            record;
BEGIN
  -- A Candy 1-of-1 edition no card holds any more. Since 2026-11-09 a 1/1 card is keyed by its
  -- own asset id (lib/chains/solana/normalize.ts), so the census re-keys and repoints every
  -- card off its old name-keyed edition; those old editions (merged Tricons, the one-row Bat
  -- Cowl / Palm Garden editions, the previous key of each genuine 1/1) are left with no holder.
  -- Only rows older than a day: a census page inserts an edition just before its holdings.
  -- Editions referenced by a CASCADE / SET NULL table are skipped outright (a delete would
  -- silently remove a user's wishlist or watchlist row); a NO ACTION reference raises and is
  -- counted, never forced.
  FOR r IN
    SELECT e.id
      FROM public.editions e
     WHERE e.collection_id = v_candy
       AND e.circulation_count = 1
       AND e.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                        WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id)
       AND NOT EXISTS (SELECT 1 FROM public.user_wishlists x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.watchlist_items x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_offers x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.pack_drop_pool x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_holders x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_lookup_failures x WHERE x.edition_id = e.id)
     ORDER BY e.created_at, e.id
     LIMIT GREATEST(coalesce(p_limit, 500), 0)
  LOOP
    v_candidates := v_candidates + 1;
    BEGIN
      DELETE FROM public.editions WHERE id = r.id;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      v_referenced := v_referenced + 1;
    END;
  END LOOP;

  -- rows_written = rows actually deleted; a referenced row is reported, not hidden.
  PERFORM public.log_pipeline_run(
    'candy-orphan-one-of-one-editions', v_started,
    v_candidates, v_deleted, v_referenced,
    true, NULL, 'candy_mlb', NULL, NULL,
    jsonb_build_object('candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced, 'limit', p_limit));
  RETURN jsonb_build_object('ok', true, 'candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced);
END
$function$;
-- <<< END verbatim candy_delete_orphan_one_of_one_editions <<<

\set CANDY '''209ade70-32c5-4470-bc7c-4793d660f713'''
\set TS    '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-000000000001', :CANDY::uuid, 'c:tricons:merged',       1,   now() - interval '3 days'),  -- orphan            -> DELETED
  ('00000000-0000-0000-0000-000000000002', :CANDY::uuid, 'c:tricons:held',         1,   now() - interval '3 days'),  -- held               -> kept
  ('00000000-0000-0000-0000-000000000003', :CANDY::uuid, 'c:tricons:fresh',        1,   now() - interval '1 hour'),  -- younger than a day -> kept
  ('00000000-0000-0000-0000-000000000004', :CANDY::uuid, 'c:tricons:wished',       1,   now() - interval '3 days'),  -- wishlisted (CASCADE) -> kept
  ('00000000-0000-0000-0000-000000000005', :CANDY::uuid, 'c:tricons:sold',         1,   now() - interval '3 days'),  -- NO ACTION ref     -> kept, counted
  ('00000000-0000-0000-0000-000000000006', :CANDY::uuid, 'c:icons:big',            850, now() - interval '3 days'),  -- not a 1/1          -> kept
  ('00000000-0000-0000-0000-000000000007', :TS::uuid,    '1:1',                    1,   now() - interval '3 days'),  -- another collection -> kept
  ('00000000-0000-0000-0000-000000000008', :CANDY::uuid, 'c:tricons:offered',      1,   now() - interval '3 days');  -- candy offer (SET NULL) -> kept
INSERT INTO public.wallet_moments_cache VALUES (:CANDY::uuid, 'c:tricons:held', 'm1');
INSERT INTO public.user_wishlists VALUES ('00000000-0000-0000-0000-000000000004');
INSERT INTO public.sales VALUES ('00000000-0000-0000-0000-000000000005');
INSERT INTO public.candy_offers VALUES ('00000000-0000-0000-0000-000000000008');

DO $$
DECLARE v jsonb;
BEGIN
  v := public.candy_delete_orphan_one_of_one_editions(500);
  PERFORM _assert_eq(v->>'deleted', '1', 'exactly the unheld, unreferenced, day-old Candy 1/1 is deleted');
  PERFORM _assert_eq(v->>'referenced', '1', '⚠ a NO ACTION reference (a sale) is caught and COUNTED, never forced');
  PERFORM _assert((SELECT NOT EXISTS (SELECT 1 FROM public.editions WHERE external_id = 'c:tricons:merged')), 'the orphan is gone');
  PERFORM _assert((SELECT count(*) = 7 FROM public.editions), 'the other seven rows are untouched');
  PERFORM _assert((SELECT count(*) = 1 FROM public.user_wishlists), '⚠ a wishlist row is never cascaded away');
  PERFORM _assert((SELECT count(*) = 1 FROM public.candy_offers WHERE edition_id IS NOT NULL), 'a candy offer keeps its edition');
  PERFORM _assert((SELECT rows_written = 1 AND ok FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'the run log counts rows DELETED');
  v := public.candy_delete_orphan_one_of_one_editions(500);
  PERFORM _assert_eq(v->>'deleted', '0', 'a second run deletes nothing new');
END $$;

ROLLBACK;

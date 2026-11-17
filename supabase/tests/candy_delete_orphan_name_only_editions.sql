-- DB invariant: public.candy_delete_orphan_name_only_editions(int) — 2026-11-09.
-- The property: deletes a Candy NAME-ONLY edition (tier, player, image NULL, circulation 0/NULL) only
-- when NO card holds it, it is older than a day, and no user / market / price / trophy row names it;
-- its EMPTY daily market snapshot goes with it, a snapshot CARRYING data keeps it; a NO ACTION
-- reference is caught and COUNTED, never forced; complete editions, other collections and fresh rows
-- are never touched; the run log counts editions actually deleted.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261110044500_audit_20261109_candy_delete_orphan_name_only_editions.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text, tier text, player_name text,
  thumbnail_url text, circulation_count int, created_at timestamptz);
CREATE TABLE public.wallet_moments_cache (collection_id uuid, edition_key text, moment_id text);
CREATE TABLE public.user_wishlists (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.watchlist_items (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.candy_offers (edition_id uuid REFERENCES public.editions(id) ON DELETE SET NULL);
CREATE TABLE public.candy_listings (edition_id uuid);
CREATE TABLE public.sales (collection_id uuid, edition_id uuid);
CREATE TABLE public.fmv_snapshots (edition_id uuid);
CREATE TABLE public.trophy_moments (edition_id text);
CREATE TABLE public.pack_drop_pool (edition_id uuid REFERENCES public.editions(id) ON DELETE SET NULL);
CREATE TABLE public.special_serial_holders (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.special_serial_lookup_failures (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.candy_edition_market_daily (edition_id uuid, day date, floor_ask_usd numeric, listed_count int,
  best_offer_usd numeric, offer_count int);
CREATE TABLE public.trade_matches (edition_id uuid REFERENCES public.editions(id));   -- NO ACTION
CREATE TABLE public.pipeline_runs_stub (pipeline text, rows_written int, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_rows_written, p_ok, p_extra) RETURNING 1::bigint $$;

-- >>> BEGIN verbatim candy_delete_orphan_name_only_editions (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.candy_delete_orphan_name_only_editions(p_limit integer DEFAULT 500)
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
  v_daily      int := 0;
  v_n          int;
  r            record;
BEGIN
  -- A NAME-ONLY Candy edition no card holds any more. DAS returned some assets without their
  -- off-chain JSON and the census keyed them from the on-chain name alone: no tier, no player,
  -- no image, no circulation (4,844 editions, 328,317 cards on 2026-11-09). Since then the
  -- census fetches the metadata and REPOINTS each card to its real edition
  -- (lib/chains/solana/hydrate.ts), leaving the name-only editions with no holder.
  -- Only rows older than a day: a census page inserts an edition just before its holdings.
  -- Skipped outright: anything a user row (CASCADE / SET NULL) or a market / price / trophy row
  -- names — a sale, FMV, listing, offer or trophy on a name-only edition is a finding to read,
  -- not something to delete under. The daily market snapshot writes a row for EVERY Candy
  -- edition; an EMPTY one is removed with the edition, one carrying data skips it. A NO ACTION
  -- reference raises and is counted, never forced.
  FOR r IN
    SELECT e.id
      FROM public.editions e
     WHERE e.collection_id = v_candy
       AND e.tier IS NULL
       AND e.player_name IS NULL
       AND e.thumbnail_url IS NULL
       AND coalesce(e.circulation_count, 0) = 0
       AND e.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                        WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id)
       AND NOT EXISTS (SELECT 1 FROM public.user_wishlists x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.watchlist_items x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_offers x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_listings x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.sales x WHERE x.collection_id = v_candy AND x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.fmv_snapshots x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.trophy_moments x WHERE x.edition_id IN (e.id::text, e.external_id))
       AND NOT EXISTS (SELECT 1 FROM public.pack_drop_pool x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_holders x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_lookup_failures x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_edition_market_daily d
                        WHERE d.edition_id = e.id
                          AND (d.floor_ask_usd IS NOT NULL OR coalesce(d.listed_count, 0) > 0
                               OR d.best_offer_usd IS NOT NULL OR coalesce(d.offer_count, 0) > 0))
     ORDER BY e.created_at, e.id
     LIMIT GREATEST(coalesce(p_limit, 500), 0)
  LOOP
    v_candidates := v_candidates + 1;
    BEGIN
      DELETE FROM public.candy_edition_market_daily WHERE edition_id = r.id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      DELETE FROM public.editions WHERE id = r.id;
      v_deleted := v_deleted + 1;
      v_daily := v_daily + v_n;
    EXCEPTION WHEN foreign_key_violation THEN
      v_referenced := v_referenced + 1;
    END;
  END LOOP;

  -- rows_written = editions actually deleted; a referenced row is reported, not hidden.
  PERFORM public.log_pipeline_run(
    'candy-orphan-name-only-editions', v_started,
    v_candidates, v_deleted, v_referenced,
    true, NULL, 'candy_mlb', NULL, NULL,
    jsonb_build_object('candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced,
                       'empty_daily_snapshots_deleted', v_daily, 'limit', p_limit));
  RETURN jsonb_build_object('ok', true, 'candidates', v_candidates, 'deleted', v_deleted,
                            'referenced', v_referenced, 'empty_daily_snapshots_deleted', v_daily);
END
$function$;
-- <<< END verbatim candy_delete_orphan_name_only_editions <<<

\set CANDY '''209ade70-32c5-4470-bc7c-4793d660f713'''
\set TS    '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
-- id, collection, key, tier, player, thumb, circ, created
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-000000000001', :CANDY::uuid, 'c:leadoff:phil-bickford', NULL, NULL, NULL, NULL, now() - interval '3 days'), -- orphan name-only -> DELETED
  ('00000000-0000-0000-0000-000000000002', :CANDY::uuid, 'c:leadoff:held',          NULL, NULL, NULL, NULL, now() - interval '3 days'), -- held             -> kept
  ('00000000-0000-0000-0000-000000000003', :CANDY::uuid, 'c:leadoff:fresh',         NULL, NULL, NULL, NULL, now() - interval '1 hour'), -- younger than a day -> kept
  ('00000000-0000-0000-0000-000000000004', :CANDY::uuid, 'c:leadoff:josh-core', 'COMMON', 'Josh', 'https://i', 1500, now() - interval '3 days'), -- complete -> kept
  ('00000000-0000-0000-0000-000000000005', :CANDY::uuid, 'c:leadoff:sold',          NULL, NULL, NULL, NULL, now() - interval '3 days'), -- a Candy sale names it -> kept
  ('00000000-0000-0000-0000-000000000006', :CANDY::uuid, 'c:leadoff:listed',        NULL, NULL, NULL, NULL, now() - interval '3 days'), -- daily snapshot WITH data -> kept
  ('00000000-0000-0000-0000-000000000007', :TS::uuid,    'ts:name-only',            NULL, NULL, NULL, NULL, now() - interval '3 days'), -- another collection -> kept
  ('00000000-0000-0000-0000-000000000008', :CANDY::uuid, 'c:leadoff:wished',        NULL, NULL, NULL, NULL, now() - interval '3 days'), -- wishlisted (CASCADE) -> kept
  ('00000000-0000-0000-0000-000000000009', :CANDY::uuid, 'c:leadoff:matched',       NULL, NULL, NULL, NULL, now() - interval '3 days'), -- NO ACTION ref -> kept, counted
  ('00000000-0000-0000-0000-00000000000a', :CANDY::uuid, 'c:leadoff:trophy',        NULL, NULL, NULL, NULL, now() - interval '3 days'), -- trophy by KEY -> kept
  ('00000000-0000-0000-0000-00000000000b', :CANDY::uuid, 'c:leadoff:has-image',     NULL, NULL, 'https://i', NULL, now() - interval '3 days'); -- not name-only -> kept
INSERT INTO public.wallet_moments_cache VALUES (:CANDY::uuid, 'c:leadoff:held', 'm1');
INSERT INTO public.sales VALUES (:CANDY::uuid, '00000000-0000-0000-0000-000000000005');
INSERT INTO public.candy_edition_market_daily VALUES
  ('00000000-0000-0000-0000-000000000001', current_date, NULL, 0, NULL, 0),   -- empty: goes with its edition
  ('00000000-0000-0000-0000-000000000006', current_date, 12.5, 1, NULL, 0);   -- carries an ask: keeps its edition
INSERT INTO public.user_wishlists VALUES ('00000000-0000-0000-0000-000000000008');
INSERT INTO public.trade_matches VALUES ('00000000-0000-0000-0000-000000000009');
INSERT INTO public.trophy_moments VALUES ('c:leadoff:trophy');

DO $$
DECLARE v jsonb;
BEGIN
  v := public.candy_delete_orphan_name_only_editions(500);
  PERFORM _assert_eq(v->>'deleted', '1', 'exactly the unheld, unreferenced, day-old Candy name-only edition is deleted');
  PERFORM _assert_eq(v->>'referenced', '1', '⚠ a NO ACTION reference (a trade match) is caught and COUNTED, never forced');
  PERFORM _assert((SELECT NOT EXISTS (SELECT 1 FROM public.editions WHERE external_id = 'c:leadoff:phil-bickford')), 'the orphan is gone');
  PERFORM _assert((SELECT count(*) = 10 FROM public.editions), 'the other ten rows are untouched');
  PERFORM _assert((SELECT NOT EXISTS (SELECT 1 FROM public.candy_edition_market_daily WHERE edition_id = '00000000-0000-0000-0000-000000000001')),
                  'its EMPTY daily snapshot went with it');
  PERFORM _assert((SELECT count(*) = 1 FROM public.candy_edition_market_daily), '⚠ a snapshot carrying data is never deleted');
  PERFORM _assert((SELECT count(*) = 1 FROM public.user_wishlists), '⚠ a wishlist row is never cascaded away');
  PERFORM _assert((SELECT count(*) = 1 FROM public.trade_matches), 'the trade match is untouched');
  PERFORM _assert((SELECT rows_written = 1 AND ok AND (extra->>'empty_daily_snapshots_deleted')::int = 1
                     FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'the run log counts editions DELETED');
  v := public.candy_delete_orphan_name_only_editions(500);
  PERFORM _assert_eq(v->>'deleted', '0', 'a second run deletes nothing new');
END $$;

ROLLBACK;

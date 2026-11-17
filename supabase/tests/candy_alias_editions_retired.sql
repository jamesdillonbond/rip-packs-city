-- DB invariant: retiring emptied Candy alias editions (#247) — candy_skip_alias_edition_insert() and
-- candy_delete_emptied_alias_editions(). Pinned 2026-11-13. What must hold:
--   1. an insert of an ALIAS key into Candy editions is skipped; a canonical / unaliased key and another collection's
--      row insert normally;
--   2. delete removes an alias edition nothing names (its market-daily and FMV rows first) — and ONLY that: an alias
--      still holding a card, carrying a sale, a listing, an offer or a wishlist stays; a canonical never goes;
--   3. a NO ACTION reference (here: a price_snapshots row) is counted as referenced, never forced.
-- The function DDL is VERBATIM from supabase/migrations/20261114013700_audit_20261113_candy_alias_editions_retired.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, external_id text);
CREATE TABLE public.candy_edition_key_aliases (alias_key text PRIMARY KEY, canonical_key text, collection_prefix text);
CREATE TABLE public.wallet_moments_cache (collection_id uuid, edition_key text);
CREATE TABLE public.sales (collection_id uuid, edition_id uuid);
CREATE TABLE public.candy_listings (edition_id uuid);
CREATE TABLE public.candy_offers (edition_id uuid);
CREATE TABLE public.user_wishlists (edition_id uuid REFERENCES public.editions(id) ON DELETE CASCADE);
CREATE TABLE public.watchlist_items (edition_id uuid);
CREATE TABLE public.pack_drop_pool (edition_id uuid);
CREATE TABLE public.special_serial_holders (edition_id uuid);
CREATE TABLE public.candy_edition_market_daily (edition_id uuid REFERENCES public.editions(id), day date);
CREATE TABLE public.fmv_snapshots (edition_id uuid REFERENCES public.editions(id));
CREATE TABLE public.price_snapshots (edition_id uuid REFERENCES public.editions(id));
CREATE TABLE public.pipeline_log (pipeline text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p text, s timestamptz, a int, b int, c int, ok boolean, e text, col text,
  x text, y text, extra jsonb) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.pipeline_log VALUES (p, extra) $$;

-- >>> BEGIN verbatim candy alias-edition retirement >>>
CREATE OR REPLACE FUNCTION public.candy_skip_alias_edition_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.external_id is not null
     and exists (select 1 from public.candy_edition_key_aliases a where a.alias_key = new.external_id) then
    return null;
  end if;
  return new;
end $fn$;
CREATE OR REPLACE FUNCTION public.candy_delete_emptied_alias_editions(p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_candy constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_started timestamptz := clock_timestamp();
  v_candidates int := 0;
  v_deleted int := 0;
  v_referenced int := 0;
  v_daily int := 0;
  v_fmv int := 0;
  v_n int;
  r record;
begin
  for r in
    select e.id
      from public.editions e
      join public.candy_edition_key_aliases a on a.alias_key = e.external_id
     where e.collection_id = c_candy
       and not exists (select 1 from public.wallet_moments_cache w
                        where w.collection_id = c_candy and w.edition_key = e.external_id)
       and not exists (select 1 from public.sales s where s.collection_id = c_candy and s.edition_id = e.id)
       and not exists (select 1 from public.candy_listings x where x.edition_id = e.id)
       and not exists (select 1 from public.candy_offers x where x.edition_id = e.id)
       and not exists (select 1 from public.user_wishlists x where x.edition_id = e.id)
       and not exists (select 1 from public.watchlist_items x where x.edition_id = e.id)
       and not exists (select 1 from public.pack_drop_pool x where x.edition_id = e.id)
       and not exists (select 1 from public.special_serial_holders x where x.edition_id = e.id)
     order by e.id
     limit greatest(coalesce(p_limit, 500), 0)
  loop
    v_candidates := v_candidates + 1;
    begin
      delete from public.candy_edition_market_daily where edition_id = r.id;
      get diagnostics v_n = row_count;
      v_daily := v_daily + v_n;
      delete from public.fmv_snapshots where edition_id = r.id;
      get diagnostics v_n = row_count;
      v_fmv := v_fmv + v_n;
      delete from public.editions where id = r.id;
      v_deleted := v_deleted + 1;
    exception when foreign_key_violation then
      v_referenced := v_referenced + 1;
    end;
  end loop;

  perform public.log_pipeline_run(
    'candy-alias-editions-retired', v_started, v_candidates, v_deleted, v_referenced, true, null, 'candy_mlb', null, null,
    jsonb_build_object('candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced,
                       'market_daily_deleted', v_daily, 'fmv_deleted', v_fmv, 'limit', p_limit,
                       'alias_editions_left', (select count(*) from public.editions e
                                                 join public.candy_edition_key_aliases a on a.alias_key = e.external_id
                                                where e.collection_id = c_candy)));
  return jsonb_build_object('ok', true, 'candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced);
end $fn$;
-- <<< END verbatim candy alias-edition retirement <<<

create trigger editions_candy_skip_alias_insert_trg
  before insert on public.editions
  for each row when (new.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
  execute function public.candy_skip_alias_edition_insert();

INSERT INTO public.candy_edition_key_aliases VALUES
  ('c:x:empty', 'c:x:canon', 'c:x'), ('c:x:held', 'c:x:canon', 'c:x'), ('c:x:sold', 'c:x:canon', 'c:x'),
  ('c:x:listed', 'c:x:canon', 'c:x'), ('c:x:offered', 'c:x:canon', 'c:x'), ('c:x:wished', 'c:x:canon', 'c:x'),
  ('c:x:priced', 'c:x:canon', 'c:x'), ('c:x:new-alias', 'c:x:canon', 'c:x');

-- rows that already exist (inserted before their key became an alias: the trigger is created above, so bypass it)
ALTER TABLE public.editions DISABLE TRIGGER editions_candy_skip_alias_insert_trg;
INSERT INTO public.editions (collection_id, external_id)
SELECT '209ade70-32c5-4470-bc7c-4793d660f713', k FROM unnest(ARRAY['c:x:canon','c:x:empty','c:x:held','c:x:sold','c:x:listed','c:x:offered','c:x:wished','c:x:priced']) k;
ALTER TABLE public.editions ENABLE TRIGGER editions_candy_skip_alias_insert_trg;

INSERT INTO public.wallet_moments_cache VALUES ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:x:held');
INSERT INTO public.sales SELECT collection_id, id FROM public.editions WHERE external_id = 'c:x:sold';
INSERT INTO public.candy_listings SELECT id FROM public.editions WHERE external_id = 'c:x:listed';
INSERT INTO public.candy_offers SELECT id FROM public.editions WHERE external_id = 'c:x:offered';
INSERT INTO public.user_wishlists SELECT id FROM public.editions WHERE external_id = 'c:x:wished';
INSERT INTO public.price_snapshots SELECT id FROM public.editions WHERE external_id = 'c:x:priced';
INSERT INTO public.candy_edition_market_daily SELECT id, current_date FROM public.editions WHERE external_id IN ('c:x:empty', 'c:x:priced');
INSERT INTO public.fmv_snapshots SELECT id FROM public.editions WHERE external_id = 'c:x:empty';

DO $$
DECLARE r jsonb;
BEGIN
  -- 1. inserts
  INSERT INTO public.editions (collection_id, external_id) VALUES
    ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:x:new-alias'),
    ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:x:fresh'),
    ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'c:x:new-alias');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.editions WHERE external_id = 'c:x:new-alias' AND collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'), '0', 'a Candy alias key is not re-created');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.editions WHERE external_id = 'c:x:fresh'), '1', 'an unaliased Candy key inserts');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.editions WHERE external_id = 'c:x:new-alias' AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'), '1', 'another collection is untouched');

  -- 2 + 3. delete
  r := public.candy_delete_emptied_alias_editions(500);
  PERFORM _assert_eq((SELECT string_agg(external_id, ',' ORDER BY external_id) FROM public.editions WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'),
    'c:x:canon,c:x:fresh,c:x:held,c:x:listed,c:x:offered,c:x:priced,c:x:sold,c:x:wished',
    'only the emptied alias goes (the NO ACTION-referenced one stays); canonical, held, sold, listed, offered, wished stay');
  PERFORM _assert_eq(r->>'deleted', '1', 'one deleted');
  PERFORM _assert_eq(r->>'referenced', '1', 'the price_snapshots reference is counted, not forced');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots), '0', 'its FMV row went first');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.candy_edition_market_daily), '1', 'its market-daily row went; the referenced one''s rolled back with it');

  RAISE NOTICE '✓ candy alias editions retired: only the emptied ones';
END $$;

ROLLBACK;

-- DB invariant: Candy edition-key aliases (#247) — refresh_candy_edition_key_aliases(), the canonical-key triggers
-- and candy_apply_edition_key_aliases(). Pinned 2026-11-13. What must hold:
--   1. same (collection prefix, tier, circulation, art) = one card: the most-held key is canonical, the others alias it;
--      a sealed item, a 1-of-1 and a key with other art are never grouped;
--   2. a refresh is stable: a later, MORE-held member does not move the canonical; a canonical is never an alias;
--   3. a holding written under an alias lands on the canonical (Candy only — another collection's row is untouched);
--      a sale / listing / offer written on an alias edition lands on the canonical edition;
--   4. apply moves rows already on an alias and reports what is left (0).
-- The function DDL is VERBATIM from supabase/migrations/20261114002600_audit_20261113_candy_edition_key_aliases.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, external_id text, tier text,
  circulation_count int, thumbnail_url text, set_name text, player_name text
);
CREATE TABLE public.wallet_moments_cache (
  id bigserial PRIMARY KEY, wallet_address text, collection_id uuid, moment_id text, edition_key text,
  tier text, mint_count int, set_name text, player_name text
);
CREATE TABLE public.sales (id uuid DEFAULT gen_random_uuid(), collection_id uuid, edition_id uuid);
CREATE TABLE public.candy_listings (pda_address text PRIMARY KEY, edition_id uuid);
CREATE TABLE public.candy_offers (pda_address text PRIMARY KEY, edition_id uuid);
CREATE TABLE public.pipeline_log (pipeline text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p text, s timestamptz, a int, b int, c int, ok boolean, e text, col text,
  x text, y text, extra jsonb) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.pipeline_log VALUES (p, extra) $$;

create table if not exists public.candy_edition_key_aliases (
  alias_key         text primary key,
  canonical_key     text not null,
  collection_prefix text not null,
  created_at        timestamptz not null default now(),
  constraint candy_edition_key_aliases_not_self check (alias_key <> canonical_key)
);
create index if not exists idx_candy_edition_key_aliases_prefix on public.candy_edition_key_aliases (collection_prefix);
create index if not exists idx_candy_edition_key_aliases_canonical on public.candy_edition_key_aliases (canonical_key);

-- >>> BEGIN verbatim candy edition-key alias functions >>>
CREATE OR REPLACE FUNCTION public.refresh_candy_edition_key_aliases()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_candy constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_started timestamptz := clock_timestamp();
  v_groups int := 0;
  v_new int := 0;
begin
  drop table if exists pg_temp._ek;
  drop table if exists pg_temp._grp;
  create temp table _ek on commit drop as
  select ed.external_id, split_part(ed.external_id, ':', 2) as pfx, ed.tier, ed.circulation_count, ed.thumbnail_url
    from public.editions ed
   where ed.collection_id = c_candy
     and ed.external_id like 'c:%'
     and ed.thumbnail_url is not null
     and coalesce(ed.circulation_count, 0) > 1
     and ed.external_id !~ ':sealed-item';

  create temp table _grp on commit drop as
  select pfx, tier, circulation_count, thumbnail_url, array_agg(external_id) as keys
    from _ek
   group by pfx, tier, circulation_count, thumbnail_url
  having count(*) > 1;
  get diagnostics v_groups = row_count;

  insert into public.candy_edition_key_aliases (alias_key, canonical_key, collection_prefix)
  select k, p.canon, 'c:' || p.pfx
    from (
      select g.pfx, g.keys,
             coalesce(
               -- a member that is already canonical keeps the group's canonical stable
               (select k0 from unnest(g.keys) k0
                 where exists (select 1 from public.candy_edition_key_aliases a where a.canonical_key = k0)
                 order by k0 limit 1),
               (select k1 from unnest(g.keys) k1
                 order by (select count(*) from public.wallet_moments_cache w
                            where w.collection_id = c_candy and w.edition_key = k1) desc,
                          length(k1) desc, k1
                 limit 1)
             ) as canon
        from _grp g
    ) p
    cross join lateral unnest(p.keys) k
   where k <> p.canon
     -- a canonical is never made an alias (no chains)
     and not exists (select 1 from public.candy_edition_key_aliases a where a.canonical_key = k)
  on conflict (alias_key) do nothing;
  get diagnostics v_new = row_count;

  perform public.log_pipeline_run(
    'candy-edition-key-aliases', v_started, v_groups, v_new, 0, true, null, 'candy_mlb', null, null,
    jsonb_build_object('groups', v_groups, 'aliases_added', v_new,
                       'aliases_total', (select count(*) from public.candy_edition_key_aliases)));
  return jsonb_build_object('ok', true, 'groups', v_groups, 'aliases_added', v_new);
end $fn$;

CREATE OR REPLACE FUNCTION public.candy_canonical_edition_key_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v text;
begin
  if new.edition_key is not null then
    select a.canonical_key into v from public.candy_edition_key_aliases a where a.alias_key = new.edition_key;
    if v is not null then
      new.edition_key := v;
    end if;
  end if;
  return new;
end $fn$;

CREATE OR REPLACE FUNCTION public.candy_canonical_edition_id_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v uuid;
begin
  if new.edition_id is not null then
    select ce.id into v
      from public.editions ae
      join public.candy_edition_key_aliases a on a.alias_key = ae.external_id
      join public.editions ce on ce.collection_id = ae.collection_id and ce.external_id = a.canonical_key
     where ae.id = new.edition_id
       and ae.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid;
    if v is not null then
      new.edition_id := v;
    end if;
  end if;
  return new;
end $fn$;

drop trigger if exists wmc_candy_canonical_edition_key_trg on public.wallet_moments_cache;
create trigger wmc_candy_canonical_edition_key_trg
  before insert or update of edition_key on public.wallet_moments_cache
  for each row when (new.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
  execute function public.candy_canonical_edition_key_trg();

drop trigger if exists sales_candy_canonical_edition_id_trg on public.sales;
create trigger sales_candy_canonical_edition_id_trg
  before insert on public.sales
  for each row when (new.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
  execute function public.candy_canonical_edition_id_trg();

drop trigger if exists candy_listings_canonical_edition_id_trg on public.candy_listings;
create trigger candy_listings_canonical_edition_id_trg
  before insert or update of edition_id on public.candy_listings
  for each row execute function public.candy_canonical_edition_id_trg();

drop trigger if exists candy_offers_canonical_edition_id_trg on public.candy_offers;
create trigger candy_offers_canonical_edition_id_trg
  before insert or update of edition_id on public.candy_offers
  for each row execute function public.candy_canonical_edition_id_trg();

CREATE OR REPLACE FUNCTION public.candy_apply_edition_key_aliases(p_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_candy constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_started timestamptz := clock_timestamp();
  v_wmc int := 0;
  v_sales int := 0;
  v_listings int := 0;
  v_offers int := 0;
  v_left bigint;
begin
  -- holdings: a bounded batch, labels from the canonical edition (identical by construction; set for certainty)
  with batch as (
    select w.id, a.canonical_key
      from public.wallet_moments_cache w
      join public.candy_edition_key_aliases a on a.alias_key = w.edition_key
     where w.collection_id = c_candy
     limit greatest(coalesce(p_limit, 5000), 0)
  )
  update public.wallet_moments_cache w
     set edition_key = b.canonical_key,
         tier        = coalesce(ce.tier, w.tier),
         mint_count  = coalesce(ce.circulation_count, w.mint_count),
         set_name    = coalesce(ce.set_name, w.set_name)
    from batch b
    join public.editions ce on ce.collection_id = c_candy and ce.external_id = b.canonical_key
   where w.id = b.id;
  get diagnostics v_wmc = row_count;

  -- market rows: few, moved whole (the edition_id triggers do the same on every new write)
  with m as (
    select ae.id as alias_id, ce.id as canon_id
      from public.candy_edition_key_aliases a
      join public.editions ae on ae.collection_id = c_candy and ae.external_id = a.alias_key
      join public.editions ce on ce.collection_id = c_candy and ce.external_id = a.canonical_key
  )
  update public.sales s set edition_id = m.canon_id
    from m where s.collection_id = c_candy and s.edition_id = m.alias_id;
  get diagnostics v_sales = row_count;

  with m as (
    select ae.id as alias_id, ce.id as canon_id
      from public.candy_edition_key_aliases a
      join public.editions ae on ae.collection_id = c_candy and ae.external_id = a.alias_key
      join public.editions ce on ce.collection_id = c_candy and ce.external_id = a.canonical_key
  )
  update public.candy_listings l set edition_id = m.canon_id from m where l.edition_id = m.alias_id;
  get diagnostics v_listings = row_count;

  with m as (
    select ae.id as alias_id, ce.id as canon_id
      from public.candy_edition_key_aliases a
      join public.editions ae on ae.collection_id = c_candy and ae.external_id = a.alias_key
      join public.editions ce on ce.collection_id = c_candy and ce.external_id = a.canonical_key
  )
  update public.candy_offers o set edition_id = m.canon_id from m where o.edition_id = m.alias_id;
  get diagnostics v_offers = row_count;

  select count(*) into v_left
    from public.wallet_moments_cache w
    join public.candy_edition_key_aliases a on a.alias_key = w.edition_key
   where w.collection_id = c_candy;

  perform public.log_pipeline_run(
    'candy-edition-key-alias-apply', v_started, v_wmc + v_sales + v_listings + v_offers,
    v_wmc + v_sales + v_listings + v_offers, 0, true, null, 'candy_mlb', null, null,
    jsonb_build_object('wmc_moved', v_wmc, 'sales_moved', v_sales, 'listings_moved', v_listings,
                       'offers_moved', v_offers, 'wmc_left', v_left, 'limit', p_limit));
  return jsonb_build_object('ok', true, 'wmc_moved', v_wmc, 'sales_moved', v_sales, 'listings_moved', v_listings,
                            'offers_moved', v_offers, 'wmc_left', v_left);
end $fn$;
-- <<< END verbatim candy edition-key alias functions <<<

-- one card under three keys (A most held), plus look-alikes that must NOT group
INSERT INTO public.editions (collection_id, external_id, tier, circulation_count, thumbnail_url, set_name) VALUES
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:justice-league-vs-suicid-1-core',       'COMMON', 5000, 'art1', 'JL'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:justice-league-vs-suicide-sq-1-core',   'COMMON', 5000, 'art1', 'JL'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:justice-league-vs-suicide-squad-core',  'COMMON', 5000, 'art1', 'JL'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:other-art-core',                        'COMMON', 5000, 'art2', 'JL'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:sealed-item',                           'COMMON', 5000, 'art1', 'JL'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:one-of-one-abc',                        'COMMON', 1,    'art1', 'JL'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:justice-league-vs-suicid-1-rare',       'RARE',   5000, 'art1', 'JL'),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:xx:justice-league-vs-suicid-1-core',       'COMMON', 5000, 'art1', 'XX');

INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key) VALUES
  ('w1', '209ade70-32c5-4470-bc7c-4793d660f713', 'm1', 'c:jl:justice-league-vs-suicid-1-core'),
  ('w2', '209ade70-32c5-4470-bc7c-4793d660f713', 'm2', 'c:jl:justice-league-vs-suicid-1-core'),
  ('w3', '209ade70-32c5-4470-bc7c-4793d660f713', 'm3', 'c:jl:justice-league-vs-suicid-1-core'),
  ('w4', '209ade70-32c5-4470-bc7c-4793d660f713', 'm4', 'c:jl:justice-league-vs-suicide-sq-1-core');

INSERT INTO public.sales (collection_id, edition_id)
SELECT collection_id, id FROM public.editions WHERE external_id = 'c:jl:justice-league-vs-suicide-squad-core';

DO $$
DECLARE r jsonb; v_a uuid; v_c uuid;
BEGIN
  r := public.refresh_candy_edition_key_aliases();
  PERFORM _assert_eq((r->>'aliases_added'), '2', 'two aliases: the cut and the full-title keys');
  PERFORM _assert_eq((SELECT string_agg(alias_key || '>' || canonical_key, ',' ORDER BY alias_key) FROM public.candy_edition_key_aliases),
    'c:jl:justice-league-vs-suicide-sq-1-core>c:jl:justice-league-vs-suicid-1-core,c:jl:justice-league-vs-suicide-squad-core>c:jl:justice-league-vs-suicid-1-core',
    'the most-held key is canonical; other art / sealed / 1-of-1 / other rarity / other collection never grouped');

  -- a new member, now the MOST held, does not move the canonical
  INSERT INTO public.editions (collection_id, external_id, tier, circulation_count, thumbnail_url, set_name) VALUES
    ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:jl:justice-league-vs-suicide-1-core', 'COMMON', 5000, 'art1', 'JL');
  INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key)
  SELECT 'n' || g, '209ade70-32c5-4470-bc7c-4793d660f713', 'n' || g, 'c:jl:justice-league-vs-suicide-1-core' FROM generate_series(1, 9) g;
  r := public.refresh_candy_edition_key_aliases();
  PERFORM _assert_eq((SELECT canonical_key FROM public.candy_edition_key_aliases WHERE alias_key = 'c:jl:justice-league-vs-suicide-1-core'),
    'c:jl:justice-league-vs-suicid-1-core', 'the canonical stays where it was');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.candy_edition_key_aliases WHERE alias_key = 'c:jl:justice-league-vs-suicid-1-core'),
    '0', 'a canonical is never an alias');

  -- writes on an alias land on the canonical
  INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key) VALUES
    ('w5', '209ade70-32c5-4470-bc7c-4793d660f713', 'm5', 'c:jl:justice-league-vs-suicide-squad-core'),
    ('w6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm6', 'c:jl:justice-league-vs-suicide-squad-core');
  PERFORM _assert_eq((SELECT edition_key FROM public.wallet_moments_cache WHERE moment_id = 'm5'),
    'c:jl:justice-league-vs-suicid-1-core', 'a Candy holding written on an alias lands on the canonical');
  PERFORM _assert_eq((SELECT edition_key FROM public.wallet_moments_cache WHERE moment_id = 'm6'),
    'c:jl:justice-league-vs-suicide-squad-core', 'another collection is untouched');

  SELECT id INTO v_a FROM public.editions WHERE external_id = 'c:jl:justice-league-vs-suicid-1-core';
  SELECT id INTO v_c FROM public.editions WHERE external_id = 'c:jl:justice-league-vs-suicide-squad-core';
  INSERT INTO public.sales (collection_id, edition_id) VALUES ('209ade70-32c5-4470-bc7c-4793d660f713', v_c);
  INSERT INTO public.candy_listings VALUES ('l1', v_c);
  INSERT INTO public.candy_offers VALUES ('o1', v_c);
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE edition_id = v_a), '1', 'a new sale on an alias edition lands on the canonical');
  PERFORM _assert_eq((SELECT edition_id::text FROM public.candy_listings WHERE pda_address = 'l1'), v_a::text, 'a listing too');
  PERFORM _assert_eq((SELECT edition_id::text FROM public.candy_offers WHERE pda_address = 'o1'), v_a::text, 'an offer too');

  -- rows already on an alias (written before the alias existed) are moved by apply
  r := public.candy_apply_edition_key_aliases(1000);
  PERFORM _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache
                       WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' AND edition_key <> 'c:jl:justice-league-vs-suicid-1-core'), '0',
    'every Candy holding of the card is on the canonical');
  PERFORM _assert_eq(r->>'wmc_left', '0', 'nothing left');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE edition_id = v_c), '0', 'the old sale moved too');
  PERFORM _assert_eq((SELECT mint_count::text FROM public.wallet_moments_cache WHERE moment_id = 'm4'), '5000', 'with the canonical labels');

  RAISE NOTICE '✓ candy edition-key aliases: one card, one key';
END $$;

ROLLBACK;

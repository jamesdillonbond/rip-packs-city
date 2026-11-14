-- audit_20261113_candy_edition_key_aliases — 2026-11-13 ~3:50 PM PT (Claude Code cloud; Trevor: "Keep going and do it
-- all"; known-issues #247).
--
-- FINDING (#247, re-sized today). One Candy card is stored under SEVERAL edition keys: the on-chain name is cut at 32
-- characters and the cut moves with the serial's digit count ("Justice League vs Suicid 1 2292" / "…Suicide Sq 1 12"),
-- a card hydrated from its off-chain JSON keys from the full title ("…suicide-squad-2016-2017-core"), and older paths
-- slugged punctuation differently ("walk-off" / "walkoff"). Every count, floor, holder total and FMV of such a card is
-- split across rows. Measured: grouping Candy editions by (collection prefix, tier, circulation, art URL) gives 1,828
-- groups / 2,068 redundant keys outside sealed items, ~205k holdings on the non-canonical keys. A sample of 161 groups
-- whose title stems are NOT simple cuts of each other read as the same card every time (same moment, other scheme).
--
-- FIX — one canonical key per card, enforced where the rows are WRITTEN (every writer, not one):
--   1. candy_edition_key_aliases (alias_key -> canonical_key), filled by refresh_candy_edition_key_aliases(): within a
--      group the canonical is the key already canonical (stable), else the most-held key (fewest rows move; its URL is
--      the one in use), then the longest. A canonical is never made an alias; an alias is never re-pointed.
--   2. BEFORE triggers rewrite an alias to its canonical on wallet_moments_cache.edition_key (Candy rows only — WHEN
--      clause, no call for other collections), and on edition_id for Candy sales, candy_listings and candy_offers.
--   3. candy_apply_edition_key_aliases(p_limit) moves rows already on an alias (holdings in batches, with the canonical
--      edition's labels; sales / listings / offers whole), logged.
--   This migration fills NO aliases and schedules nothing: the first refresh and the crons follow in a second migration
--   once the census code that resolves aliases is deployed, so the old census never meets a filled table.
--   The census resolves aliases in code too (lib/candy/collections-census.ts), so its REPOINT does not flap.
-- Excluded: 1-of-1s (keyed by asset id on purpose), sealed items, rows without art or circulation.
-- anon-exec: refresh_candy_edition_key_aliases, candy_apply_edition_key_aliases, candy_canonical_edition_key_trg and
-- candy_canonical_edition_id_trg are NOT anon-executable (EXECUTE revoked from public, anon, authenticated).
-- Revert: drop the four triggers + crons; aliases already applied stay merged (the rows were split copies of one card).
-- Falsifier: after the backlog drains, the same-art grouping above returns groups only for keys born since the last
-- refresh, and no Candy holding sits on an alias key.

create table if not exists public.candy_edition_key_aliases (
  alias_key         text primary key,
  canonical_key     text not null,
  collection_prefix text not null,
  created_at        timestamptz not null default now(),
  constraint candy_edition_key_aliases_not_self check (alias_key <> canonical_key)
);
create index if not exists idx_candy_edition_key_aliases_prefix on public.candy_edition_key_aliases (collection_prefix);
create index if not exists idx_candy_edition_key_aliases_canonical on public.candy_edition_key_aliases (canonical_key);
alter table public.candy_edition_key_aliases enable row level security;
revoke all on table public.candy_edition_key_aliases from public, anon, authenticated;
grant select, insert, update, delete on table public.candy_edition_key_aliases to service_role;

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

revoke all on function public.refresh_candy_edition_key_aliases() from public, anon, authenticated;
revoke all on function public.candy_canonical_edition_key_trg() from public, anon, authenticated;
revoke all on function public.candy_canonical_edition_id_trg() from public, anon, authenticated;
revoke all on function public.candy_apply_edition_key_aliases(integer) from public, anon, authenticated;

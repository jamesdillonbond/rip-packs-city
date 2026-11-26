-- audit_20261126_property_groups_and_owner_splits
--
-- Three read-only helpers for the league / brand level (publisher_properties):
--
--   get_panini_property_groups(slug, limit)   the teams / nations / clubs / clans of one Panini league or
--       brand, from the group Panini prints on the card (panini_editions.nation — a TEAM on NBA / NFL / WNBA
--       cards, a NATION on World Cup cards, a clan on Bad Eggs). Says how many cards name one, so a section
--       built on a fifth of the cards cannot read as the whole league.
--   panini_owner_property_split(username)     a collector's Panini cards by league / brand, from
--       panini_user_holdings (the full walked holdings — not the 500-row page the Binder reads). A card that
--       has since been seen with another owner is left out, as in panini_profile_holdings.
--   candy_wallet_property_split(wallet)       a Solana wallet's Candy cards by league / brand, from
--       wallet_moments_cache (scoped to Candy's collection_id — a moment_id is unique only within a collection).
--
-- Revert: remove the callers (lib/panini/properties.ts readPaniniPropertyGroups, app/api/league-split), then
-- the three functions. No table changes.

CREATE OR REPLACE FUNCTION public.get_panini_property_groups(p_slug text, p_limit integer default 12)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $fn$
  with prop as (
    select slug, group_word from public.publisher_properties where publisher = 'panini' and slug = p_slug
  ), ed as (
    select nullif(btrim(pe.nation), '') grp, f.fmv_usd
    from public.panini_products pp
    join public.panini_editions pe on pe.product_set_id = pp.set_id
    join public.editions e
      on e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid and e.external_id = pe.external_id
    left join public.edition_fmv_current f on f.edition_id = e.id
    where pp.property_slug = p_slug
  ), g as (
    select grp, count(*)::int editions, count(*) filter (where fmv_usd > 0)::int priced_editions,
           round(sum(fmv_usd) filter (where fmv_usd > 0), 2) fmv_total_usd
    from ed where grp is not null group by 1
  )
  select case when not exists (select 1 from prop) then null else jsonb_build_object(
    'group_word', (select group_word from prop),
    'editions_total', (select count(*) from ed),
    'editions_named', (select count(*) from ed where grp is not null),
    'groups_total', (select count(*) from g),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('name', x.grp, 'editions', x.editions,
                 'priced_editions', x.priced_editions, 'fmv_total_usd', x.fmv_total_usd)
               order by x.fmv_total_usd desc nulls last, x.editions desc, x.grp)
        from (select * from g order by fmv_total_usd desc nulls last, editions desc, grp
              limit least(greatest(coalesce(p_limit, 12), 1), 60)) x), '[]'::jsonb)
  ) end
$fn$;
-- anon-exec: revoked (get_panini_property_groups) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.get_panini_property_groups(text, integer) from public, anon, authenticated;
grant execute on function public.get_panini_property_groups(text, integer) to postgres, service_role;

CREATE OR REPLACE FUNCTION public.panini_owner_property_split(p_username text)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $fn$
  with u as (select lower(btrim(p_username)) username),
  held as (
    select substring(coalesce(s.edition_external_id, h.psku) from '^packcard-([0-9]+)_')::int set_id
    from public.panini_user_holdings h
    join u on u.username = h.username
    left join public.panini_card_serials s on s.sku = h.url_key
    where not (coalesce(s.owner, '') <> '' and lower(s.owner) <> u.username and s.captured_at > h.last_seen_at)
  ), placed as (
    select pp.property_slug slug, count(*)::int cards
    from held left join public.panini_products pp on pp.set_id = held.set_id
    group by 1
  )
  select jsonb_build_object(
    'cards_total', (select coalesce(sum(cards), 0) from placed),
    'unplaced', (select coalesce(sum(cards), 0) from placed where slug is null),
    'leagues', coalesce((select jsonb_agg(jsonb_build_object('slug', p.slug, 'name', pr.name, 'heading', pr.heading, 'cards', p.cards)
                 order by p.cards desc, pr.sort_order)
        from placed p join public.publisher_properties pr on pr.publisher = 'panini' and pr.slug = p.slug), '[]'::jsonb))
$fn$;
-- anon-exec: revoked (panini_owner_property_split) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.panini_owner_property_split(text) from public, anon, authenticated;
grant execute on function public.panini_owner_property_split(text) to postgres, service_role;

CREATE OR REPLACE FUNCTION public.candy_wallet_property_split(p_wallet text)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $fn$
  with held as (
    select c.property_slug slug, count(*)::int cards
    from public.wallet_moments_cache w
    left join public.editions e
      on e.collection_id = w.collection_id and e.external_id = w.edition_key
    left join public.candy_collections c on c.set_id = e.set_id
    where w.wallet_address = p_wallet
      and w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    group by 1
  )
  select jsonb_build_object(
    'cards_total', (select coalesce(sum(cards), 0) from held),
    'unplaced', (select coalesce(sum(cards), 0) from held where slug is null),
    'leagues', coalesce((select jsonb_agg(jsonb_build_object('slug', h.slug, 'name', pr.name, 'heading', pr.heading, 'cards', h.cards)
                 order by h.cards desc, pr.sort_order)
        from held h join public.publisher_properties pr on pr.publisher = 'candy' and pr.slug = h.slug), '[]'::jsonb))
$fn$;
-- anon-exec: revoked (candy_wallet_property_split) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.candy_wallet_property_split(text) from public, anon, authenticated;
grant execute on function public.candy_wallet_property_split(text) to postgres, service_role;

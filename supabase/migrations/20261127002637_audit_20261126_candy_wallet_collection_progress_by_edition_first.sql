-- audit_20261126_candy_wallet_collection_progress_by_edition_first
--
-- The Candy Sets tab's "Every Candy collection you hold" panel (/api/candy-collections-progress). Same defect
-- and same fix as candy_wallet_property_split (20261127002421): `editions` was probed once per held CARD
-- (555k buffers, 30 s cold on a 125k-card wallet). Cards are now counted per edition key first and each
-- edition is looked up once. Same signature, same json; md5 compared before and after on four wallets.
--
-- Revert: re-apply candy_wallet_collection_progress from 20261126231408.

CREATE OR REPLACE FUNCTION public.candy_wallet_collection_progress(p_wallet text)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $fn$
  with k as materialized (
    select w.edition_key, count(*)::int cards
    from public.wallet_moments_cache w
    where w.wallet_address = p_wallet
      and w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    group by 1
  ), held as (
    select e.set_id, sum(k.cards)::int cards, count(distinct e.id)::int owned_editions
    from k
    join public.editions e
      on e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid and e.external_id = k.edition_key
    group by e.set_id
  ), tot as (
    select e.set_id, count(*)::int editions, min(e.set_name) set_name
    from public.editions e
    where e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
      and e.set_id in (select set_id from held)
    group by e.set_id
  )
  select jsonb_build_object(
    'collections_total', (select count(*) from public.candy_collections where kind <> 'test'),
    'collections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', c.name,
               'set_slug', regexp_replace(lower(tot.set_name), '[^a-z0-9]+', '-', 'g'),
               'brand', c.property_slug, 'brand_name', pr.name, 'line', c.program,
               'editions', tot.editions, 'owned_editions', held.owned_editions, 'cards', held.cards)
             order by (held.owned_editions::numeric / nullif(tot.editions, 0)) desc nulls last, held.cards desc, c.name)
      from held
      join tot on tot.set_id = held.set_id
      join public.candy_collections c on c.set_id = held.set_id and c.kind <> 'test'
      left join public.publisher_properties pr on pr.publisher = 'candy' and pr.slug = c.property_slug), '[]'::jsonb))
$fn$;
-- anon-exec: unchanged (candy_wallet_collection_progress) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false).

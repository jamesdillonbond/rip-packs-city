-- audit_20261126_candy_wallet_collection_progress
--
-- The Candy Sets tab, beyond the 2026 MLB Base Series: every Candy collection a wallet holds a card of, with
-- how many of its DIFFERENT cards the wallet has, and its league / brand. Reads wallet_moments_cache (scoped
-- to Candy's collection_id) -> editions -> candy_collections. `editions` is the count RPC has catalogued for
-- the collection — a floor on its checklist, which the tab says. Collections the wallet holds nothing of are
-- not listed (385 rows of 0 would be noise); the response carries how many there are.
--
-- Revert: remove the caller (app/api/candy-collections-progress), then the function.

CREATE OR REPLACE FUNCTION public.candy_wallet_collection_progress(p_wallet text)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $fn$
  with held as (
    select e.set_id, count(*)::int cards, count(distinct e.id)::int owned_editions
    from public.wallet_moments_cache w
    join public.editions e on e.collection_id = w.collection_id and e.external_id = w.edition_key
    where w.wallet_address = p_wallet
      and w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
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
-- anon-exec: revoked (candy_wallet_collection_progress) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.candy_wallet_collection_progress(text) from public, anon, authenticated;
grant execute on function public.candy_wallet_collection_progress(text) to postgres, service_role;

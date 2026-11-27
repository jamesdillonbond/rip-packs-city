-- audit_20261126_candy_wallet_property_split_by_edition_first
--
-- /api/league-split?publisher=candy (the dashboard's Candy tile and the Candy Binder's brand chips) timed out
-- for a 125k-card wallet: the function probed `editions` once per held CARD (548k buffers, 28 s cold). A
-- wallet holds many copies of few editions (125,407 cards, 3,696 editions), so the cards are now counted per
-- edition key first (index-only on the holder index) and each edition is looked up once: 47k buffers, 2.0 s
-- cold. Same signature, same json; md5 of the result compared before and after on four wallets.
--
-- Revert: re-apply candy_wallet_property_split from 20261126214413.

CREATE OR REPLACE FUNCTION public.candy_wallet_property_split(p_wallet text)
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
    select c.property_slug slug, sum(k.cards)::int cards
    from k
    left join public.editions e
      on e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid and e.external_id = k.edition_key
    left join public.candy_collections c on c.set_id = e.set_id
    group by 1
  )
  select jsonb_build_object(
    'cards_total', (select coalesce(sum(cards), 0) from held),
    'unplaced', (select coalesce(sum(cards), 0) from held where slug is null),
    'leagues', coalesce((select jsonb_agg(jsonb_build_object('slug', h.slug, 'name', pr.name, 'heading', pr.heading, 'cards', h.cards)
                 order by h.cards desc, pr.sort_order)
        from held h join public.publisher_properties pr on pr.publisher = 'candy' and pr.slug = h.slug), '[]'::jsonb))
$fn$;
-- anon-exec: unchanged (candy_wallet_property_split) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false).

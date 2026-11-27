-- audit_20261126_panini_owner_property_split_owned_skus_first
--
-- /api/league-split?publisher=panini (the dashboard's Panini tile line). For the largest Panini profile RPC
-- holds (29,422 cards) the function took 45-64 s: it fetched one panini_card_serials heap row per held card
-- (157k buffers, 42-48k of them read from disk every time — that table does not stay cached).
--
-- The serial row was read for two things: the product id (from its edition key) and whether a LATER capture
-- shows a different owner. For a card whose serial currently names this user as owner, neither needs the
-- heap: the owner check passes by definition, and the product id in the holding's own psku equals the one in
-- the serial's edition key (0 differences over the 17,364 holdings of the other 21 profiles, measured 11-26).
-- So: the user's owned skus come index-only from idx_panini_serials_owner_lower_sku, holdings among them take
-- the product id from psku, and only the remainder (no serial row, blank owner, another owner, or a psku with
-- no product id) goes through the original per-card read, unchanged.
-- Same signature, same json; md5 of the result compared before and after for all 22 profiles.
--
-- Revert: re-apply panini_owner_property_split from 20261126214413.

CREATE OR REPLACE FUNCTION public.panini_owner_property_split(p_username text)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $fn$
  with u as materialized (select lower(btrim(p_username)) username),
  own as materialized (
    select s.sku
    from public.panini_card_serials s
    where lower(s.owner) = (select username from u) and s.owner <> ''
  ),
  h as materialized (
    select h.url_key, h.psku, h.last_seen_at,
           (o.sku is not null and h.psku ~ '^packcard-[0-9]+_') as fast
    from public.panini_user_holdings h
    left join own o on o.sku = h.url_key
    where h.username = (select username from u)
  ),
  held as (
    select substring(h.psku from '^packcard-([0-9]+)_')::int set_id
    from h where h.fast
    union all
    select substring(coalesce(s.edition_external_id, h.psku) from '^packcard-([0-9]+)_')::int set_id
    from h
    left join public.panini_card_serials s on s.sku = h.url_key
    where not h.fast
      and not (coalesce(s.owner, '') <> '' and lower(s.owner) <> (select username from u) and s.captured_at > h.last_seen_at)
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
-- anon-exec: unchanged (panini_owner_property_split) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false).

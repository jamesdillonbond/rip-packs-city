-- audit_20261126_candy_market_board_for_property
--
-- The Candy Market tab's league / brand scope (?property=<slug>): the rows of candy_market_board whose
-- card belongs to a collection of that brand. A function returning the view's own row type, so the API
-- keeps every filter, sort and limit it already applies to the view (PostgREST filters an RPC result).
-- An unknown slug returns no rows; the API refuses an unknown slug before calling this, so "no rows"
-- here always means "nothing of this brand is listed".
--
-- Revert: remove the caller (app/api/market/route.ts, the Candy arm's `property` branch), then the function.

CREATE OR REPLACE FUNCTION public.candy_market_board_for_property(p_slug text)
returns setof public.candy_market_board
language sql stable
set search_path = pg_catalog, public
as $fn$
  select b.*
  from public.candy_market_board b
  where b.edition_id in (
    select e.id
    from public.editions e
    join public.candy_collections c on c.set_id = e.set_id
    where c.property_slug = p_slug
      and e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  )
$fn$;
-- anon-exec: revoked (candy_market_board_for_property) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.candy_market_board_for_property(text) from public, anon, authenticated;
grant execute on function public.candy_market_board_for_property(text) to postgres, service_role;

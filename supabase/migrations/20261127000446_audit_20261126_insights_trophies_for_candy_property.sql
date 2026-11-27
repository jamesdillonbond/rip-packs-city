-- audit_20261126_insights_trophies_for_candy_property
--
-- The Trophy Room's league / brand scope for Candy (?collection=candy_mlb&property=<slug>): the rows of
-- get_insights_trophies('{candy_mlb}') whose card belongs to a collection of that brand. It returns the board
-- view's own row type, so the board keeps its class filter, sort and limit (PostgREST filters an RPC result
-- like a table). Measured 11-26: 5,226 Candy trophy rows — 5,217 MLB, 5 Sweet Futures, 4 DC — 340 ms.
-- An unknown slug returns no rows; the API refuses an unknown slug before calling this.
--
-- Revert: remove the caller (lib/insights/trophies-board.ts, the `candyProperty` branch), then the function.

CREATE OR REPLACE FUNCTION public.insights_trophies_for_candy_property(p_slug text)
returns setof public.v_insights_trophies
language sql stable
set search_path = pg_catalog, public
as $fn$
  select v.*
  from public.get_insights_trophies(array['candy_mlb']) v
  where v.edition_id in (
    select e.id
    from public.editions e
    join public.candy_collections c on c.set_id = e.set_id
    where c.property_slug = p_slug
      and e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  )
$fn$;
-- anon-exec: revoked (insights_trophies_for_candy_property) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.insights_trophies_for_candy_property(text) from public, anon, authenticated;
grant execute on function public.insights_trophies_for_candy_property(text) to postgres, service_role;

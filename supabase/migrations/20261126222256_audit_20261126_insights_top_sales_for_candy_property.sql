-- audit_20261126_insights_top_sales_for_candy_property
--
-- The Top Sales board's league / brand scope for Candy (?collection=candy_mlb&property=<slug>): the rows of
-- v_insights_top_sales whose card belongs to a collection of that brand. It returns the view's own row type,
-- so the board keeps its window, sort and limit (PostgREST filters an RPC result like a table). An unknown
-- slug returns no rows; the API refuses an unknown slug before calling this.
--
-- Revert: remove the caller (lib/insights/top-sales.ts, the `candyProperty` branch), then the function.

CREATE OR REPLACE FUNCTION public.insights_top_sales_for_candy_property(p_slug text)
returns setof public.v_insights_top_sales
language sql stable
set search_path = pg_catalog, public
as $fn$
  select v.*
  from public.v_insights_top_sales v
  where v.collection = 'candy_mlb'
    and v.edition_id in (
      select e.id
      from public.editions e
      join public.candy_collections c on c.set_id = e.set_id
      where c.property_slug = p_slug
        and e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
    )
$fn$;
-- anon-exec: revoked (insights_top_sales_for_candy_property) — new function; revoked from PUBLIC, anon, authenticated below.
revoke execute on function public.insights_top_sales_for_candy_property(text) from public, anon, authenticated;
grant execute on function public.insights_top_sales_for_candy_property(text) to postgres, service_role;

-- audit_20261010_panini_set_progress_products
--
-- The per-PRODUCT summary behind the Panini Sets tab's product picker. panini_set_progress_all
-- returns one row per (product, set) — 1,928 rows on 2026-10-10 PT, past PostgREST's 1,000-row
-- clamp — so /api/panini-set-progress reads ONE product's sets (filtered on product_set_id) and
-- this summary for the picker (one row per product, ~100), never the whole list through the clamp.
-- Same function underneath, so the picker's counts and the table's rows cannot disagree.
--
-- anon-exec: revoked (panini_set_progress_products) — new function; REVOKE FROM PUBLIC, anon, authenticated below, service_role only.
--
-- REVERT: drop function public.panini_set_progress_products(text);

create function public.panini_set_progress_products(p_username text)
returns table(product_set_id integer, product_name text, sport text, sets integer, editions_seen integer, owned integer,
  owner_last_seen_at timestamp with time zone)
language sql stable
set search_path = public
as $function$
  SELECT s.product_set_id,
         max(s.product_name),
         max(s.sport),
         count(*)::integer,
         sum(s.editions_seen)::integer,
         sum(s.owned)::integer,
         max(s.owner_last_seen_at)
  FROM panini_set_progress_all(p_username) s
  GROUP BY s.product_set_id
  ORDER BY s.product_set_id = 2332 DESC, sum(s.editions_seen) DESC, s.product_set_id;
$function$;
revoke all on function public.panini_set_progress_products(text) from public, anon, authenticated;
grant execute on function public.panini_set_progress_products(text) to postgres, service_role;
comment on function public.panini_set_progress_products(text) is
  'One row per Panini product for the Sets tab picker: sets, editions seen and (with a username) editions owned, over panini_set_progress_all. Keeps the tab off the 1,000-row PostgREST clamp. 2026-10-10.';

-- NWSL #1065: name card set 2478 + link the pack row(s). Applied 2026-11-22 ~4:40 PM PT, version 20261123004017.
-- NWSL #1065 ("2026 Panini NFT Prizm Black NWSL Soccer Packs", sold out 2026-11-20): name card set
-- 2478 with Panini's exact collection_name so panini-ingest's exact-name map links the pack.
-- Evidence (2026-11-22 ~3:xx PM PT): set 2478 = 80 editions, thumbnails under pack/1065/ (54) and
-- pack/1064/ (26, base Silver/Red Wave only); Base Prizms Silver #174, Red Wave #46, Mojo #25,
-- Gold #10, Gold Vinyl 1/1 -- matches the pack label. No other panini_products row carries the name.
-- Set 2460 (insert-only, same product) stays UNNAMED: two rows with one name make the route's
-- name -> set map nondeterministic (panini-pack-ev-strategy-2026-11-22.md §0).
-- Revert: update panini_products set name = null where set_id = 2478;
--         update panini_pack_state set product_set_id = null where product_set_id = 2478;
do $$
begin
  if exists (select 1 from public.panini_products
             where set_id <> 2478
               and lower(trim(name)) = lower(trim('2026 Panini NFT Prizm Black NWSL Soccer'))) then
    raise exception 'another panini_products row already carries the NWSL name';
  end if;
end $$;

update public.panini_products
   set name = '2026 Panini NFT Prizm Black NWSL Soccer'
 where set_id = 2478 and name is null;

update public.panini_pack_state
   set product_set_id = 2478
 where product_set_id is null
   and lower(trim(product_name)) = lower(trim('2026 Panini NFT Prizm Black NWSL Soccer'));

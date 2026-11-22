-- audit_20261122_panini_pack_state_link_rolling_stones_bad_eggs
--
-- 2026-11-22 (Claude Code cloud; Trevor: "Do what you can").
--
-- WHY. 20261122192317 named panini_products 2130 / 850130, but the ingest route only writes product_set_id when it
-- RE-CAPTURES a pack page (full runs); packs 979/990/1060/1063 were last captured 11-21 6:40 PM PT / 11-22 10:39 AM PT,
-- before the names existed. This writes exactly what the route's setIdByName lookup will write on the next capture
-- (collection_name -> panini_products.name -> set_id), so the products are linked now rather than at the next full run.
-- Guarded: only rows whose product_name matches the named product and whose product_set_id is still NULL.
--
-- REVERT: update public.panini_pack_state set product_set_id = null where id in ('979','990','1060','1063');
--         (only meaningful together with reverting 20261122192317, or the next capture re-links them)

update public.panini_pack_state s
   set product_set_id = p.set_id
  from public.panini_products p
 where s.id in ('979', '990', '1060', '1063')
   and s.product_set_id is null
   and p.set_id in (2130, 850130)
   and lower(trim(s.product_name)) = lower(trim(p.name));

-- audit_20261122_panini_products_name_clans_new_yolk_rookie_royalty
--
-- 2026-11-22 (Claude Code cloud; Trevor: "Do what you think is best, and research the answers yourself" — strategy P2.7,
-- the two Bad Eggs products left unlinked by 20261122192317, plus every other live pack whose product is walked but unnamed).
--
-- FOUND. Panini's own Entertainment marketplace grid (read in Trevor's Chrome, 11-22 ~12:45 PM PT) lists Bad Eggs cards
-- under set ids 850130 (named earlier), 850147 and 850179. Both are ALREADY registered and walked (walk_cards = true,
-- 172 / 273 cards) — they were simply never NAMED, so the route's link-by-name never matched (same gap as 2130 / 850130).
-- EVIDENCE (mint caps vs each product's published serial ranges):
--   850147  Silver #269, Green #45, Red #79, Yellow #149 (+ "The Clans" insert parallels)
--           = "2025 Panini NFT Prizm Bad Eggs - Introducing the Clans" (Uncommon #269, Rare #79-149, Green packs UR #45)
--   850179  Silver #499, Blue #283, Red #159, Green #49, Bronze #45 (+ The Teams / Starcade inserts)
--           = "2026 Panini NFT Bad Eggs - The Teams of New Yolk City" (Uncommon #283-499, Rare #159, Green packs #49,
--             Bronze packs #45)
--   2123    the 2024 WNBA rookie class only (Clark, Reese, Brink, Cardoso, ...), Epic #5-25 / Ultra Rare #47-49 /
--           Legendary 1/1 and nothing else = "2024 Panini NFT WNBA Rookie Royalty" (pack 1000: Epic #5-25, Ultra Rare
--           #47-49, Legendary 1/1 — no lower tier at all)
-- The route will write the same product_set_id at its next pack capture; this writes it now, guarded on name equality.
-- Still unlinked after this: 2022 NFL Dilfer's Dimes (6 packs, 11-31 sealed each) and 2022 NRJ Music Awards (2 sealed) —
-- no walked set to match; not worth a runner change.
--
-- REVERT: update public.panini_products set name = null where set_id in (850147, 850179, 2123);
--         update public.panini_pack_state set product_set_id = null where id in ('1012','1013','1053','1057','1061','1000');

update public.panini_products set name = '2025 Panini NFT Prizm Bad Eggs - Introducing the Clans'
 where set_id = 850147 and name is null;
update public.panini_products set name = '2026 Panini NFT Bad Eggs - The Teams of New Yolk City'
 where set_id = 850179 and name is null;
update public.panini_products set name = '2024 Panini NFT WNBA Rookie Royalty'
 where set_id = 2123 and name is null;

update public.panini_pack_state s
   set product_set_id = p.set_id
  from public.panini_products p
 where s.id in ('1012', '1013', '1053', '1057', '1061', '1000')
   and s.product_set_id is null
   and p.set_id in (850147, 850179, 2123)
   and lower(trim(s.product_name)) = lower(trim(p.name));

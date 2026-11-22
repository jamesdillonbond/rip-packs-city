-- audit_20261122_panini_products_name_rolling_stones_bad_eggs
--
-- 2026-11-22 (Claude Code cloud; Trevor: "Work through all you can for p1 and p2" — strategy P2.7, C4).
--
-- WHY. The ingest route links a pack to its card product BY NAME (panini_products.name = the pack payload's
-- collection_name). Two entertainment products were already registered and walked — set 2130 (770 cards) and set
-- 850130 (155 cards) — but with name NULL, so packs 979/990 (2025 Prizm Bad Eggs) and 1060/1063 (2026 Prizm The
-- Rolling Stones) stayed product_set_id NULL: no EV model, no shadow, no product page link.
-- EVIDENCE (11-22, mint caps vs each product's published serial ranges):
--   2130   Silver #437, Black and Red Checker #248, Blue Ice #99, Tie-Dye #49, White Sparkle #8, Black Finite 1/1 =
--          the Rolling Stones packs (Uncommon #248-437, Rare #99, Ultra Rare #49, White Sparkles pack Epic #8). One
--          Rolling Stones product exists.
--   850130 Silver #407, Red Pulsar #79, Yellow Wave #145, Green Power #39 = "2025 Panini NFT Prizm Bad Eggs"
--          (Uncommon #407, Rare #79-145, Green Power pack Ultra Rare #39); the Clans (#269, #45) and New Yolk City
--          (#283-499, #159, #49) products do not match.
-- The other two Bad Eggs products have no registered set id — the runner has never reported their cards.
--
-- REVERT: update public.panini_products set name = null where set_id in (2130, 850130);
--         (then the next ingest run writes product_set_id null back onto those packs)

update public.panini_products set name = '2026 Panini NFT Prizm The Rolling Stones'
 where set_id = 2130 and name is null;
update public.panini_products set name = '2025 Panini NFT Prizm Bad Eggs'
 where set_id = 850130 and name is null;

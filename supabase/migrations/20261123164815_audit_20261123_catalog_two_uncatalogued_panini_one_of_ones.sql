-- 2026-11-23 ~8:50 AM PT (Trevor, live: "Yes do it all").
--
-- The week's two biggest Panini sales were missing from /insights/top-sales and the Monday X
-- draft because neither card was in panini_editions, so v_panini_top_sales's inner join on
-- editions dropped them (a never-listed 1/1 is never seen by the listing walk):
--   packcard-1605_293026_7958740_56__1_1   $10,000  sold 11-17 7:40 AM PT
--   packcard-2478_555348_13056695_55__1_1  $7,500   sold 11-21 1:30 PM PT
--
-- Identity, derived and then CONFIRMED on Panini's own CDN:
--   * card number 56 is Erling Haaland in all six catalogued parallels of set 1605; parallel
--     293026 is Base Mosaic Black (9 catalogued siblings, all 1/1); its art file
--     056A_77101_0035F1_FIFABase_BC_1-8_1_1.png returns 200 and shows Haaland, Norway, 1/1.
--   * card number 55 is Trinity Rodman in all three catalogued parallels of set 2478; parallel
--     555348 is Base Prizms Gold Vinyl (all 1/1); 055A_115689_0176F1_Base_BC_1-15_1_1.png returns
--     200 and shows Trinity Rodman, Washington Spirit, 1/1. Both .mp4s return 206.
--
-- product_set_id is a GENERATED column (from external_id), so it is not inserted.
-- Counts: pulled_count 1 / still_in_packs 0 are KNOWN (the one serial exists and sold).
-- for_sale_count and burned_count are UNKNOWN, so NULL — never the column's 0 default.
-- last_seen_at NULL: the walk has never seen either card. The walker's upsert on id will fill
-- these in if it ever does. sync_panini_products_bridge (pg_cron 631, :24/:54) carries both
-- rows into editions, which is what v_panini_top_sales reads.
--
-- Revert: DELETE FROM public.panini_editions WHERE id IN
--   ('packcard-1605_293026_7958740_56__1_1','packcard-2478_555348_13056695_55__1_1');
--   (then the bridged editions rows by the same external_id + Panini collection_id.)

INSERT INTO public.panini_editions
  (id, external_id, collection_id, player_name, nation, set_name, parallel, parallel_family,
   rarity_label, tier, mint_cap, pulled_count, still_in_packs, for_sale_count, burned_count,
   is_fotl_exclusive, serial_low_ask_usd, thumbnail_url, video_url, first_minted_at,
   last_seen_at)
VALUES
  ('packcard-1605_293026_7958740_56__1_1', 'packcard-1605_293026_7958740_56',
   'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'Erling Haaland', 'Norway',
   'Base Mosaic Black', 'Base Mosaic Black', 'base', 'Legendary', 'ULTIMATE', 1, 1, 0, NULL, NULL,
   false, NULL,
   'pack/719/thumbnail/pack/Soccer/2022Mosaic_FIFA/Master/056A_77101_0035F1_FIFABase_BC_1-8_1_1.png',
   'pack/Soccer/2022Mosaic_FIFA/Master/056A_77101_0035F1_FIFABase_BC_1-8.mp4',
   NULL, NULL),
  ('packcard-2478_555348_13056695_55__1_1', 'packcard-2478_555348_13056695_55',
   'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'Trinity Rodman', 'Washington Spirit',
   'Base Prizms Gold Vinyl', 'Base Prizms Gold Vinyl', 'base', 'Legendary', 'ULTIMATE', 1, 1, 0, NULL, NULL,
   false, NULL,
   'pack/1065/thumbnail/pack/WomenSoccer/2026_PrizmBlack_NWSL/cards/055A_115689_0176F1_Base_BC_1-15_1_1.png',
   'pack/WomenSoccer/2026_PrizmBlack_NWSL/cards/055A_115689_0176F1_Base_BC_1-15.mp4',
   NULL, NULL)
ON CONFLICT (id) DO NOTHING;

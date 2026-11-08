-- audit_20261108_candy_team_balls_and_house_wallets
--
-- Two Candy follow-ups from the 11-08 support review (Trevor: "Figure those two out").
--
-- 1. 2024 MLB Team Balls — the fifth Candy set. A free 2024 fan claim (one 3D ball per
--    club), migrated to Solana; Candy's 09-29 Postseason Team Ball Quest counts them, and
--    they trade on Magic Eden / OpenSea. Found under the bare ME symbol
--    `2024_mlb_team_ball` (no `_candy_digital` suffix — why the first search missed it):
--    Core collection 5ENXADdhd29JgJA1rN7Fhf3CBgLD825LdwngncJgv5ck, externalUrl
--    candy.io/item/…, media on permaweb.candy.io; 44 listed, floor 0.175 SOL on 11-08.
--    The registry entry (lib/chains/solana/candy-sets.ts, key ball24) needs this row.
--
-- 2. Two Candy-owned wallets ranked #1 and #3 on the Candy holder board. Traced on chain
--    (public Solana RPC, Core TransferV1 accounts: asset, collection, payer, authority,
--    new_owner), sampled mints from wallet_moments_cache:
--    a. Bh43uNnQgFC11gS5bQ6sE8sJVBNBSQi95PjN1U2fUAC3 — the ICON BUYBACK wallet. 8 of 8
--       sampled Base ICONs arrived 10-09/10-10 (Candy's Sell Back window opened 10-09
--       3 PM ET, blog 10-06) from 8 DIFFERENT owners, each signing its own transfer with
--       Candy's fee payer FE8qdc… paying. Last activity 10-12 (the lock). 1,067 Base ICONs.
--    b. 6uKecEEDfWyWY6HLkPJ2kpKUgq8HekLRjtuTatoPqCaW — Candy's unpulled inventory. 6 of 6
--       sampled Base ICONs were minted 07-15 to Candy's mint wallet BhA2Bf…, never owned by
--       anyone else, and moved here 11-06 by authority 7wixES… with payer 2K9BZn… (6,000+
--       such transfers that day, across several Candy collections). 1,644 Base ICONs.
--    Neither has a sale, listing, offer or pack trade. The exclusion list feeds the holder
--    board, get_candy_edition_top_owners, get_candy_player_top_collectors and the pack
--    market; its own rule lifts an exclusion the moment the wallet trades.
--    Controls: #2 (99UgF7…, 1,624) and #4 (8N1Tij…, 585) traced as collectors — bought on
--    ME / moved by their owner, re-homed by Candy's 10-22 wallet migration — and stay.
--
-- Rollback: DELETE FROM candy_holder_board_exclusions WHERE wallet_address IN
--   ('Bh43uNnQgFC11gS5bQ6sE8sJVBNBSQi95PjN1U2fUAC3','6uKecEEDfWyWY6HLkPJ2kpKUgq8HekLRjtuTatoPqCaW');
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_candy_holder_board;
--   the sets row can stay (unused once the registry entry is reverted).

INSERT INTO public.sets (id, external_id, collection_id, name, series) VALUES
  ('362e7419-2983-490d-9165-16d41f12e2ec', 'candy-mlb-team-balls-2024', '209ade70-32c5-4470-bc7c-4793d660f713', '2024 MLB Team Balls', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.candy_holder_board_exclusions (wallet_address, reason, evidence, decided_by) VALUES
  ('Bh43uNnQgFC11gS5bQ6sE8sJVBNBSQi95PjN1U2fUAC3',
   'Candy ICON Buyback wallet (identified 2026-11-08): collectors sold ICONs back to Candy for Candy Credits in the 10-09 to 10-16 Sell Back window; this wallet received them. Candy property, not a collector.',
   jsonb_build_object('measured_at','2026-11-08','base_icons',1067,'sampled_mints',8,'arrived','2026-10-09/10',
     'distinct_previous_owners',8,'fee_payer','FE8qdc (Candy)','last_activity','2026-10-12',
     'source','https://blog.candy.io/sell-it-back-introducing-the-candy-icon-buyback/',
     'market_activity',jsonb_build_object('sales',0,'listings',0,'offers',0,'pack_trades',0)),
   'Cowork under Trevor''s request, 2026-11-08'),
  ('6uKecEEDfWyWY6HLkPJ2kpKUgq8HekLRjtuTatoPqCaW',
   'Candy inventory wallet (identified 2026-11-08): holds ICONs minted to Candy''s mint wallet and never owned by a collector, moved here 2026-11-06 by Candy''s transfer authority. Not a collector.',
   jsonb_build_object('measured_at','2026-11-08','base_icons',1644,'sampled_mints',6,'minted_to','BhA2Bf (Candy mint wallet)',
     'moved','2026-11-06','authority','7wixES','fee_payer','2K9BZn','transfers_that_day','6000+',
     'market_activity',jsonb_build_object('sales',0,'listings',0,'offers',0,'pack_trades',0)),
   'Cowork under Trevor''s request, 2026-11-08')
ON CONFLICT DO NOTHING;

REFRESH MATERIALIZED VIEW public.mv_candy_holder_board;

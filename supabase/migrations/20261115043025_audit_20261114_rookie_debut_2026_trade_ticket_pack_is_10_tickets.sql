-- audit_20261114_rookie_debut_2026_trade_ticket_pack_is_10_tickets
--
-- WHAT: Top Shot dist 8918 "Rookie Debut Trade Ticket Pack" (2026-27 Rookie Debut drop, Nov 11 2026) had no
-- ticket count (metadata.retail_price_usd NULL), so get_wallet_pack_history priced it NULL instead of
-- tickets x the lowest Top Shot ask (Trevor 2026-11-14 rule). Two sources give 10 trade tickets:
--   * blog.nbatopshot.com/posts/rookie-debut-drop-guide: "Rookie Debut Trade Ticket Pack: 10 trade tickets",
--     5,000 available, on sale Nov 11 2026 3:30 PM ET;
--   * the dist's own Atlas description: "... 3 Moments with no duplicate edition, for 10 trade tickets."
-- Same raw format as every other Top Shot Trade Ticket dist ('10').
-- seed_topshot_pack_distributions strips nulls before merging, so a NULL from Studio cannot wipe it.
-- NOT set: 8785 WNBA Rookie Revelation Trade Ticket Pack and 1571 Run It Back: Quick Rips August (Trade Ticket):
-- no published ticket count was found (Top Shot's sold-out pack page and the drop post omit it).
--
-- REVERT: UPDATE public.pack_distributions SET metadata = metadata - 'retail_price_usd'
--         WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = '8918';

UPDATE public.pack_distributions
   SET metadata = metadata || jsonb_build_object('retail_price_usd', '10', 'ticket_count_source', 'blog.nbatopshot.com/posts/rookie-debut-drop-guide')
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND dist_id = '8918'
   AND metadata->>'retail_price_usd' IS NULL;

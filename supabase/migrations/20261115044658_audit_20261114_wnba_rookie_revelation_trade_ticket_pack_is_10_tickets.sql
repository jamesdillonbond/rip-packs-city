-- audit_20261114_wnba_rookie_revelation_trade_ticket_pack_is_10_tickets
--
-- WHAT: Top Shot dist 8785 "WNBA Rookie Revelation Trade Ticket Pack" (Sep 23 2026, 10,000 for sale) had no
-- ticket count (metadata.retail_price_usd NULL), so get_wallet_pack_history priced it NULL. The drop post
-- (blog.nbatopshot.com/posts/wnba-rookie-revelation-and-holo-icon-return) omits it; the source is the dist's
-- own registration in Dapper's Pack Distribution Service on mainnet:
--   PDS.getDistInfo(8785) (0xb6f2481eba4df97b, Flow REST 2026-11-14 ~9:30 PM PT) -> metadata.price = "10",
--   distributionUUID 8cccb291-7bc2-48f3-b8db-c2351bae540f.
-- CONTROL: the same read returns price "10" for dists 8643, 8601, 8564, 8526, 8514 — every recent Trade
-- Ticket dist whose 10-ticket count is already stored — so PDS price is the ticket count for this pack type.
-- Dist 1571 (Run It Back: Quick Rips August (Trade Ticket)) has NO price key in PDS: still unset.
-- Fill-only (only when NULL); seed_topshot_pack_distributions strips nulls, so Studio cannot wipe it.
--
-- REVERT: UPDATE public.pack_distributions SET metadata = metadata - 'retail_price_usd' - 'ticket_count_source'
--         WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = '8785';

UPDATE public.pack_distributions
   SET metadata = metadata || jsonb_build_object(
         'retail_price_usd', '10',
         'ticket_count_source', 'onchain PDS.getDistInfo(8785).metadata.price')
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND dist_id = '8785'
   AND metadata->>'retail_price_usd' IS NULL;

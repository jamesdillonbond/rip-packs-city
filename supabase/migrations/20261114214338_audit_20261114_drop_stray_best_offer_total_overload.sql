-- 2026-11-14 (~1:44 PM PT, Cowork cloud; Trevor: "Approve both") — drop the (text, uuid) overload of
-- get_wallet_best_offer_total that 20261114205525 created by name collision (renamed to
-- get_wallet_edition_bid_total in 20261114211820). No caller. The July concierge function
-- get_wallet_best_offer_total(p_wallet text) is untouched (md5(prosrc) 99ad31e7d52b6cc5143303d2bb53659a
-- read immediately before the drop).
-- Revert: re-run the CREATE FUNCTION in 20261114205525 (nothing calls it).
DROP FUNCTION public.get_wallet_best_offer_total(text, uuid);

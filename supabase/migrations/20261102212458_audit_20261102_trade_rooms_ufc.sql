-- audit_20261102: TRADE ROOMS — UFC STRIKE joins NBA Top Shot, NFL All Day and LaLiga Golazos
-- (Trevor, 2026-11-02 ~1:22 PM PT: "Yes do it"). The deployed UFC_NFT contract
-- (0x329feb3ab062d289; /storage|public/UFC_NFTCollection, plain withdraw, no locking) was read
-- from mainnet, and the multi-collection swap including UFC was SIMULATED on mainnet with
-- real linked Dapper accounts first (Top Shot + Golazos + UFC both ways: 5/5 landed); Dapper's
-- filter exposes UFC's withdraw capability to a Flow Wallet parent on both accounts probed.
-- Disney Pinnacle and every pack contract stay out: the same probe found their withdraw
-- capability hidden from the parent by Dapper's filter (Golazos packs issue none at all).
--
-- Widens the two CHECKs from 20261102205817 to the long-form slug `ufc_strike`.
-- anon-exec: n/a. RLS unchanged.
-- Revert (only while no item is UFC):
--   ALTER TABLE public.trade_room_items DROP CONSTRAINT trade_room_items_collection_check,
--     ADD CONSTRAINT trade_room_items_collection_check CHECK (collection IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos'));
--   ALTER TABLE public.trade_rooms DROP CONSTRAINT trade_rooms_collection_check,
--     ADD CONSTRAINT trade_rooms_collection_check CHECK (collection IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'mixed'));

ALTER TABLE public.trade_room_items
  DROP CONSTRAINT IF EXISTS trade_room_items_collection_check;
ALTER TABLE public.trade_room_items
  ADD CONSTRAINT trade_room_items_collection_check CHECK (collection IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'ufc_strike'));

ALTER TABLE public.trade_rooms
  DROP CONSTRAINT IF EXISTS trade_rooms_collection_check;
ALTER TABLE public.trade_rooms
  ADD CONSTRAINT trade_rooms_collection_check CHECK (collection IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'ufc_strike', 'mixed'));

COMMENT ON COLUMN public.trade_room_items.collection IS
  'collections.slug of the moment (nba_top_shot / nfl_all_day / laliga_golazos / ufc_strike). Moment ids collide across collections, so every key includes it.';

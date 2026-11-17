-- audit_20261102: TRADE ROOMS ACROSS COLLECTIONS — NBA Top Shot, NFL All Day and LaLiga Golazos
-- in one room and one transaction (Trevor, 2026-11-02 ~12:26 PM PT: "go ahead and start" All
-- Day / Golazos signing; docs/strategy/features/trading.md). The swap Cadence
-- (lib/trade-room/multi-swap-cadence.ts) was simulated on mainnet with real linked Dapper
-- accounts first: Top Shot + Golazos crossing both ways in one transaction, and the All Day
-- withdrawal leg, all landed.
--
-- • trade_room_items gains `collection` (collections.slug long form). A moment id is unique
--   only WITHIN a collection (CLAUDE.md, #142), so the keys widen to include it:
--   PK (room_id, side, collection, moment_id); a moment is on at most one side of a room per
--   collection: UNIQUE (room_id, collection, moment_id). Existing rows (0 at apply time) are
--   Top Shot by the old CHECK, hence the default.
-- • trade_rooms.collection may now name any of the three, or 'mixed' when a room holds more
--   than one; the store keeps it in step with the items (lib/trade-room/store.ts setItems).
--
-- anon-exec: n/a (no function). RLS unchanged (service role only).
-- Revert (only while every item is Top Shot):
--   ALTER TABLE public.trade_room_items DROP CONSTRAINT trade_room_items_room_collection_moment_key,
--     DROP CONSTRAINT trade_room_items_pkey, ADD PRIMARY KEY (room_id, side, moment_id),
--     ADD CONSTRAINT trade_room_items_room_id_moment_id_key UNIQUE (room_id, moment_id), DROP COLUMN collection;
--   ALTER TABLE public.trade_rooms DROP CONSTRAINT trade_rooms_collection_check,
--     ADD CONSTRAINT trade_rooms_collection_check CHECK (collection = 'nba_top_shot');

ALTER TABLE public.trade_room_items
  ADD COLUMN IF NOT EXISTS collection text NOT NULL DEFAULT 'nba_top_shot'
    CONSTRAINT trade_room_items_collection_check CHECK (collection IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos'));

ALTER TABLE public.trade_room_items
  DROP CONSTRAINT IF EXISTS trade_room_items_room_id_moment_id_key,
  DROP CONSTRAINT IF EXISTS trade_room_items_pkey;

ALTER TABLE public.trade_room_items
  ADD CONSTRAINT trade_room_items_pkey PRIMARY KEY (room_id, side, collection, moment_id),
  ADD CONSTRAINT trade_room_items_room_collection_moment_key UNIQUE (room_id, collection, moment_id);

ALTER TABLE public.trade_rooms
  DROP CONSTRAINT IF EXISTS trade_rooms_collection_check;
ALTER TABLE public.trade_rooms
  ADD CONSTRAINT trade_rooms_collection_check CHECK (collection IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'mixed'));

COMMENT ON COLUMN public.trade_room_items.collection IS
  'collections.slug of the moment (nba_top_shot / nfl_all_day / laliga_golazos). Moment ids collide across collections, so every key includes it.';

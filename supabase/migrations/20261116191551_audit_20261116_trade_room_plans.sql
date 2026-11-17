-- 2026-11-16 (PT) — a trade room started from /trades/compare carries the planned trade
-- (Trevor: "Yes" to "have the trade room pre-fill a planned trade").
--
-- One row per room opened from Compare: which Top Shot Moments the room's creator (side A)
-- planned to give and which the partner (side B) planned to give, with a display snapshot
-- read SERVER-SIDE from RPC's index at creation (never the browser's text). Like the Trade
-- Block proposal it is a GUIDE, never a pick: each side adds its own planned Moments with one
-- tap, through the room's normal `items` action — chain-checked held, unlocked, not listed,
-- and receivable — and only what both accept moves.
--
-- Service role only (RLS on, no policies; anon/authenticated revoked), like every trade_room_*
-- table. Deleted with its room (ON DELETE CASCADE), so prune_trade_rooms needs no change.
-- Revert: DROP TABLE public.trade_room_plans;

CREATE TABLE IF NOT EXISTS public.trade_room_plans (
  room_id uuid PRIMARY KEY REFERENCES public.trade_rooms(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  partner_username text NOT NULL CHECK (char_length(partner_username) BETWEEN 1 AND 40),
  a_gives jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(a_gives) = 'array' AND jsonb_array_length(a_gives) <= 10),
  b_gives jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(b_gives) = 'array' AND jsonb_array_length(b_gives) <= 10),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.trade_room_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_room_plans FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.trade_room_plans TO service_role;

COMMENT ON TABLE public.trade_room_plans IS
  'A trade planned on /trades/compare (2026-11-16), carried into the room it started: a_gives / b_gives = [{collection, moment_id, player_name, set_name, serial_number}] snapshotted server-side from wallet_moments_cache. A guide for the picks, never a pick. Service role only via /api/trade-room.';

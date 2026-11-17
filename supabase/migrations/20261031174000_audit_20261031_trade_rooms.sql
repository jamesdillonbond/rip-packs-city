-- audit_20261031: TRADE ROOMS — user-to-user Top Shot trades, two signatures on one
-- transaction, no custody (Trevor, 2026-10-31: "continue building out our trade
-- features" → "User-to-user trade room"; docs/strategy/trading-revisit-2026-10-03.md §4
-- shape A). RPC stores the PROPOSAL (who gives what to whom, whether both sides have
-- accepted the exact same version of it) and relays wallet B's signature between two
-- browser sessions, exactly as the admin swap test does (swap_test_relay). RPC never
-- holds a key, a moment or a fee.
--
-- The on-chain step (asking a wallet to sign) is GATED by the RPC_TRADE_ROOM_EXECUTE
-- env until the live two-signer swap test (/admin/swap-test) has sealed once on
-- Trevor's own wallets. Everything up to that step — rooms, invites, moment picks,
-- chain checks, fair-trade hints, acceptances — works now.
--
-- Service role only (routes under /api/trade-room enforce the signed-in user and the
-- user's side). No functions, no pg_cron.
--
-- Revert: DROP TABLE public.trade_room_relay, public.trade_room_items,
--         public.trade_room_sides, public.trade_rooms; (interactively confirmed).

CREATE TABLE IF NOT EXISTS public.trade_rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the invite code in the room URL (/trades/<code>); unguessable, not sequential
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{10}$'),
  -- nullable so delete_user_account's tree walk can anonymise it (the room row stays;
  -- the user's side row is deleted, so the room reads "counterparty left")
  created_by      uuid,
  collection      text NOT NULL DEFAULT 'nba_top_shot' CHECK (collection = 'nba_top_shot'),
  -- open: waiting for the counterparty · building: both in, editing · accepted: both
  -- accepted the current version · signing: a wallet has been asked to sign · sealed ·
  -- cancelled. "expired" is read from expires_at, never written.
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','building','accepted','signing','sealed','cancelled')),
  -- bumps on every change to either side; an acceptance names the version it accepted
  version         int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  tx_id           text CHECK (tx_id IS NULL OR tx_id ~ '^[0-9a-f]{64}$'),
  -- after the seal: [{id, to, held}] from a chain read; NULL until read
  landed          jsonb,
  sealed_at       timestamptz,
  cancelled_by    uuid,
  cancel_reason   text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 200),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_rooms_sealed_has_tx CHECK (status <> 'sealed' OR (tx_id IS NOT NULL AND sealed_at IS NOT NULL)),
  CONSTRAINT trade_rooms_cancelled_has_who CHECK (status <> 'cancelled' OR cancelled_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS trade_rooms_created_by_idx ON public.trade_rooms (created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS public.trade_room_sides (
  room_id           uuid NOT NULL REFERENCES public.trade_rooms (id) ON DELETE CASCADE,
  side              text NOT NULL CHECK (side IN ('a','b')),
  user_id           uuid NOT NULL,
  -- the Flow Wallet this user PROVED they control (FCL account proof), once they have
  signer            text CHECK (signer IS NULL OR signer ~ '^0x[0-9a-f]{16}$'),
  -- where this side's moments sit: the signer itself, or a Hybrid Custody child it
  -- has redeemed (a Dapper account), chosen from the chain's own linked-account list
  source            text CHECK (source IS NULL OR source ~ '^0x[0-9a-f]{16}$'),
  proven_at         timestamptz,
  -- the room version this side accepted; NULL = not accepted (reset on every change)
  accepted_version  int CHECK (accepted_version IS NULL OR accepted_version >= 1),
  -- the user read the withdrawal notice (a moment leaving a Dapper account stops
  -- counting toward Top Shot Score, sets and challenges) before accepting
  notice_read_at    timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, side),
  UNIQUE (room_id, user_id),
  CONSTRAINT trade_room_sides_source_needs_signer CHECK (source IS NULL OR signer IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS trade_room_sides_user_idx ON public.trade_room_sides (user_id);

CREATE TABLE IF NOT EXISTS public.trade_room_items (
  room_id        uuid NOT NULL REFERENCES public.trade_rooms (id) ON DELETE CASCADE,
  side           text NOT NULL CHECK (side IN ('a','b')),
  moment_id      text NOT NULL CHECK (moment_id ~ '^[0-9]{1,20}$'),
  -- a snapshot of what RPC knew when the moment was added (for display; the chain is
  -- re-read before anyone signs)
  edition_key    text,
  serial_number  int,
  player_name    text,
  set_name       text,
  tier           text,
  series_number  int,
  image_url      text,
  -- RPC's FMV at add time, kept ONLY when its confidence was HIGH or MEDIUM; the
  -- tier itself is never stored or shown (FMV confidence is internal, 2026-10-18)
  fmv_usd        numeric,
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, side, moment_id),
  -- a moment is on at most one side of a room
  UNIQUE (room_id, moment_id),
  FOREIGN KEY (room_id, side) REFERENCES public.trade_room_sides (room_id, side) ON DELETE CASCADE
);

-- The co-signer relay, one per signing attempt. Same shape as swap_test_relay
-- (20261004025551) plus the room it belongs to; only the swap transaction's own
-- Cadence may travel through it (lib/swap-test/relay.ts checkSignable).
CREATE TABLE IF NOT EXISTS public.trade_room_relay (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid NOT NULL REFERENCES public.trade_rooms (id) ON DELETE CASCADE,
  cosigner       text NOT NULL CHECK (cosigner ~ '^0x[0-9a-f]{16}$'),
  signable       jsonb NOT NULL,
  signature      text CHECK (signature IS NULL OR signature ~ '^[0-9a-f]{128}$'),
  key_id         int  CHECK (key_id IS NULL OR key_id >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  signed_at      timestamptz,
  CONSTRAINT trade_room_relay_signed_has_key
    CHECK ((signature IS NULL AND key_id IS NULL AND signed_at IS NULL)
        OR (signature IS NOT NULL AND key_id IS NOT NULL AND signed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS trade_room_relay_room_idx ON public.trade_room_relay (room_id, created_at DESC);

ALTER TABLE public.trade_rooms       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_room_sides  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_room_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_room_relay  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_rooms, public.trade_room_sides, public.trade_room_items, public.trade_room_relay
  FROM anon, authenticated;

COMMENT ON TABLE public.trade_rooms IS
  'User-to-user Top Shot trade proposals (2026-10-31). Two signatures on one transaction, no custody; the on-chain step is gated by RPC_TRADE_ROOM_EXECUTE until the live swap test seals. Service role only via /api/trade-room.';
COMMENT ON COLUMN public.trade_room_items.fmv_usd IS
  'RPC FMV at add time, present only when confidence was HIGH/MEDIUM; the confidence tier is internal and never stored here.';

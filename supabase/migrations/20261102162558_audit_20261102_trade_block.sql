-- audit_20261102: THE TRADE BLOCK — public listings of assets a collector would trade,
-- what they want back, and proposals on them (Trevor, 2026-11-02: "a Trade Block or
-- Trade Post, where users can put up assets that they'd like to trade, maybe even also
-- mention what they're looking for in return"; decisions the same morning: browsing is
-- PUBLIC, a trade can span COLLECTIONS and carry SEVERAL items, NO CASH at this time).
-- Spec: docs/strategy/features/trading.md §3.
--
-- The block is the DISCOVERY layer and never moves an asset. An accepted proposal whose
-- every moment is NBA Top Shot hands off to a trade room (/trades/<code>, migration
-- 20261031174000), whose chain checks and two signatures are the only thing that moves
-- anything.
--
-- Ownership evidence is a PROVEN account only (FCL account proof → the wallet and the
-- Hybrid Custody account it links, read from the chain): trade_block_wallets. The
-- listing-challenge verification on saved_wallets lost its data source (#59) and is
-- not used.
--
-- Every person column is named user_id, so delete_user_account's catalog walk
-- (20261012052403) deletes a leaving user's wallets, listings and proposals by rule;
-- listing/proposal children cascade.
--
-- Service role only (routes under /api/trade-block and /api/public/trade-block shape
-- what is public: usernames, items, FMV — never a wallet address). No functions here;
-- expiry is read from expires_at, never written.
--
-- Revert: DROP TABLE public.trade_block_proposal_items, public.trade_block_proposals,
--         public.trade_block_items, public.trade_block_listings, public.trade_block_wallets;

CREATE TABLE IF NOT EXISTS public.trade_block_wallets (
  user_id     uuid NOT NULL,
  -- the Flow Wallet the user proved they control (account proof)
  signer      text NOT NULL CHECK (signer ~ '^0x[0-9a-f]{16}$'),
  -- the account the assets sit in: the signer itself or a Hybrid Custody child it has
  -- redeemed (a Dapper account), chosen from the chain's own linked-account list
  source      text NOT NULL CHECK (source ~ '^0x[0-9a-f]{16}$'),
  proven_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);
CREATE INDEX IF NOT EXISTS trade_block_wallets_source_idx ON public.trade_block_wallets (source);

CREATE TABLE IF NOT EXISTS public.trade_block_listings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the public URL (/trades/block/<code>); unguessable, not sequential
  code             text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{10}$'),
  user_id          uuid NOT NULL,
  -- filtered in the app: no URL, email, payment rail, money amount or contact handle
  note             text CHECK (note IS NULL OR length(note) <= 280),
  open_to_offers   boolean NOT NULL DEFAULT true,
  -- "expired" is read from expires_at, never written
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_reason    text CHECK (closed_reason IS NULL OR closed_reason IN ('owner','traded','account')),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  CONSTRAINT trade_block_listings_closed_has_reason CHECK (status <> 'closed' OR (closed_reason IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS trade_block_listings_open_idx ON public.trade_block_listings (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS trade_block_listings_user_idx ON public.trade_block_listings (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.trade_block_items (
  listing_id     uuid NOT NULL REFERENCES public.trade_block_listings (id) ON DELETE CASCADE,
  -- offer: something the poster holds and would give · want: something they'd take
  role           text NOT NULL CHECK (role IN ('offer','want')),
  pos            smallint NOT NULL CHECK (pos BETWEEN 0 AND 9),
  collection_id  uuid NOT NULL,
  -- moment: one held asset (offer only) · edition: any copy of an edition · player: any
  -- asset of a player (a Pinnacle character) in this collection
  kind           text NOT NULL CHECK (kind IN ('moment','edition','player')),
  moment_id      text CHECK (moment_id IS NULL OR moment_id ~ '^[0-9A-Za-z:_.-]{1,80}$'),
  -- the PROVEN account the offered moment sits in. Never published.
  source         text CHECK (source IS NULL OR source ~ '^0x[0-9a-f]{16}$'),
  edition_key    text,
  -- display snapshot (what RPC knew when posted)
  player_name    text,
  set_name       text,
  tier           text,
  series_number  int,
  serial_number  int,
  image_url      text,
  -- RPC FMV at post time, ONLY when its confidence was HIGH or MEDIUM; the tier is
  -- never stored or shown (FMV confidence is internal, 2026-10-18)
  fmv_usd        numeric CHECK (fmv_usd IS NULL OR fmv_usd >= 0),
  PRIMARY KEY (listing_id, role, pos),
  CONSTRAINT trade_block_items_moment_shape CHECK (
    (kind = 'moment' AND role = 'offer' AND moment_id IS NOT NULL AND source IS NOT NULL)
    OR (kind = 'edition' AND edition_key IS NOT NULL AND moment_id IS NULL AND source IS NULL)
    OR (kind = 'player' AND player_name IS NOT NULL AND moment_id IS NULL AND source IS NULL)
  ),
  CONSTRAINT trade_block_items_offer_is_moment CHECK (role <> 'offer' OR kind = 'moment')
);
CREATE INDEX IF NOT EXISTS trade_block_items_collection_idx ON public.trade_block_items (collection_id, role);

CREATE TABLE IF NOT EXISTS public.trade_block_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{10}$'),
  listing_id    uuid NOT NULL REFERENCES public.trade_block_listings (id) ON DELETE CASCADE,
  -- the PROPOSER (named user_id so the account-deletion walk removes it by rule)
  user_id       uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  note          text CHECK (note IS NULL OR length(note) <= 280),
  -- the trade room opened from an accepted all-Top-Shot proposal
  room_code     text CHECK (room_code IS NULL OR room_code ~ '^[a-z0-9]{10}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CONSTRAINT trade_block_proposals_decided CHECK (status = 'pending' OR decided_at IS NOT NULL),
  CONSTRAINT trade_block_proposals_room_needs_accept CHECK (room_code IS NULL OR status = 'accepted')
);
-- one PENDING proposal per proposer per listing
CREATE UNIQUE INDEX IF NOT EXISTS trade_block_proposals_one_pending ON public.trade_block_proposals (listing_id, user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS trade_block_proposals_user_idx ON public.trade_block_proposals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_block_proposals_listing_idx ON public.trade_block_proposals (listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.trade_block_proposal_items (
  proposal_id    uuid NOT NULL REFERENCES public.trade_block_proposals (id) ON DELETE CASCADE,
  -- give: from the proposer's proven accounts · get: an offered moment of the listing
  role           text NOT NULL CHECK (role IN ('give','get')),
  pos            smallint NOT NULL CHECK (pos BETWEEN 0 AND 9),
  collection_id  uuid NOT NULL,
  moment_id      text NOT NULL CHECK (moment_id ~ '^[0-9A-Za-z:_.-]{1,80}$'),
  -- give lines only: the proposer's proven account. Never published.
  source         text CHECK (source IS NULL OR source ~ '^0x[0-9a-f]{16}$'),
  edition_key    text,
  player_name    text,
  set_name       text,
  tier           text,
  series_number  int,
  serial_number  int,
  image_url      text,
  fmv_usd        numeric CHECK (fmv_usd IS NULL OR fmv_usd >= 0),
  PRIMARY KEY (proposal_id, role, pos),
  UNIQUE (proposal_id, collection_id, moment_id),
  CONSTRAINT trade_block_proposal_items_give_has_source CHECK (role <> 'give' OR source IS NOT NULL)
);

ALTER TABLE public.trade_block_wallets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_block_listings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_block_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_block_proposals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_block_proposal_items  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_block_wallets, public.trade_block_listings, public.trade_block_items,
              public.trade_block_proposals, public.trade_block_proposal_items
  FROM anon, authenticated;

COMMENT ON TABLE public.trade_block_listings IS
  'The Trade Block (2026-11-02): public listings of assets a collector would trade and what they want back. Discovery only; an accepted all-Top-Shot proposal opens a trade room. Service role only via /api/trade-block and /api/public/trade-block (no wallet address is ever published).';
COMMENT ON TABLE public.trade_block_wallets IS
  'Accounts a user PROVED for the Trade Block (FCL account proof + the chain''s linked-account list). The only ownership evidence the block accepts.';

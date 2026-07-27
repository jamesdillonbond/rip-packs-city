-- Applied to prod via Supabase MCP on 2026-07-27 as
-- audit_20260727_candy_pack_layer_tables. Committed here for parity.
--
-- Candy sealed-PACK layer. The ME collection mixes Item Type=Pack assets with
-- the ICONs; packs are not editions, so every Candy pipeline dropped them:
--   * candy-editions-ingest DAS-walks all 27,876 assets and discards the 2,501
--     packs (`packs_skipped`) — it already pays for the fetch,
--   * candy-sales-indexer saw pack sales and could not resolve them (they were
--     the first three rows the 07-26 dead letter caught: 0.39-0.45 SOL against
--     a $10 retail pack — a 3-3.4x secondary premium, discarded every tick),
--   * candy-listings-indexer drops pack asks because its wmc gate only knows
--     card mints.
--
-- HONESTY CONSTRAINT (same as candy_listings / candy_offers): a listing is an
-- ASK and a pack sale is a PACK price. Neither may ever be folded into
-- fmv_snapshots or any per-edition FMV.
--
-- REVERT: DROP TABLE IF EXISTS public.candy_pack_listings, public.candy_pack_sales, public.candy_packs;

CREATE TABLE IF NOT EXISTS public.candy_packs (
  token_mint    text PRIMARY KEY,
  collection_id uuid NOT NULL,
  serial_number integer,
  pack_supply   integer,
  owner         text,
  is_burnt      boolean NOT NULL DEFAULT false,
  name          text,
  image_url     text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.candy_packs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_packs FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_candy_packs_owner ON public.candy_packs (owner);
CREATE INDEX IF NOT EXISTS idx_candy_packs_live ON public.candy_packs (serial_number) WHERE is_burnt = false;
COMMENT ON TABLE public.candy_packs IS
  'Candy sealed-pack assets (Item Type=Pack) from the daily DAS group walk. is_burnt=true is an OPENED/redeemed pack. Added 2026-07-27.';

CREATE TABLE IF NOT EXISTS public.candy_pack_sales (
  transaction_hash text NOT NULL,
  token_mint       text NOT NULL,
  collection_id    uuid NOT NULL,
  serial_number    integer,
  price_sol        numeric,
  price_usd        numeric,
  buyer            text,
  seller           text,
  marketplace      text NOT NULL DEFAULT 'magic_eden',
  sold_at          timestamptz NOT NULL,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candy_pack_sales_pkey PRIMARY KEY (transaction_hash, token_mint)
);
ALTER TABLE public.candy_pack_sales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_pack_sales FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_candy_pack_sales_sold_at ON public.candy_pack_sales (sold_at DESC);
COMMENT ON TABLE public.candy_pack_sales IS
  'Candy sealed-pack secondary sales (Magic Eden). NEVER folded into fmv_snapshots — a pack price is not an edition FMV. Added 2026-07-27.';

CREATE TABLE IF NOT EXISTS public.candy_pack_listings (
  pda_address   text PRIMARY KEY,
  token_mint    text NOT NULL,
  collection_id uuid NOT NULL,
  seller        text,
  auction_house text,
  price_sol     numeric,
  price_usd     numeric,
  expiry        timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  is_active     boolean NOT NULL DEFAULT true
);
ALTER TABLE public.candy_pack_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_pack_listings FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_candy_pack_listings_active ON public.candy_pack_listings (is_active, price_usd);
COMMENT ON TABLE public.candy_pack_listings IS
  'Candy sealed-pack asks (Magic Eden). ASK floor only, never FMV. Added 2026-07-27.';

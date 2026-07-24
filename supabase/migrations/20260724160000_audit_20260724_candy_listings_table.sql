-- Item A — Candy (Solana) secondary LISTINGS (asks) capture. Candy's only prior
-- market signals were sales + bids; there was NO ask/listing feed, which blocked
-- the entire deals/sniper/offer-spread family. This lands the ask side.
-- pda_address = the Magic Eden listing PDA (stable per-listing identity), mirroring
-- candy_offers' pda_address PK. edition_id resolves via wmc (moment_id = mint).
-- RLS on + anon/authenticated REVOKED: route-gating is NOT data-gating (2026-07-19).
-- HONESTY: a listing is an ASK, never FMV — never fold into fmv_snapshots.
-- Applied live via MCP; this file is for repo/rebuild parity (re-applying is harmless).
-- Revert: DROP VIEW public.candy_listing_floor; DROP TABLE public.candy_listings;
CREATE TABLE IF NOT EXISTS public.candy_listings (
  pda_address    text PRIMARY KEY,
  token_mint     text NOT NULL,
  edition_id     uuid REFERENCES public.editions(id),
  collection_id  uuid NOT NULL,
  seller         text,
  auction_house  text,
  price_sol      numeric,
  price_usd      numeric,
  token_size     integer,
  expiry         timestamptz,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  is_active      boolean     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_candy_listings_edition_active
  ON public.candy_listings (edition_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_candy_listings_active_seen
  ON public.candy_listings (is_active, last_seen_at);

ALTER TABLE public.candy_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_listings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.candy_listings TO service_role;

-- Per-edition floor over ACTIVE listings. This is the ask side the deals /
-- offer-spread boards read. security_invoker; anon/authenticated REVOKED.
CREATE OR REPLACE VIEW public.candy_listing_floor
WITH (security_invoker = true) AS
SELECT
  l.edition_id,
  min(l.price_sol)                       AS floor_sol,
  min(l.price_usd)                       AS floor_usd,
  count(*)                               AS listing_count,
  count(DISTINCT l.seller)               AS distinct_sellers,
  max(l.last_seen_at)                    AS last_seen_at
FROM public.candy_listings l
WHERE l.is_active AND l.edition_id IS NOT NULL AND l.price_usd IS NOT NULL AND l.price_usd > 0
GROUP BY l.edition_id;

REVOKE ALL ON public.candy_listing_floor FROM anon, authenticated;
GRANT SELECT ON public.candy_listing_floor TO service_role;

-- UFC Strike asks on Aptos (Rarible). Measured 2026-11-15: 255 live UFC listings (183 single, 72 in bundles) across
-- 198 editions, and RPC's UFC FMV sat ABOVE the cheapest live ask on 100 of 166 editions (e.g. Spivac FN Feb 4 2023
-- $58.50 vs $18.31). This table holds the live listings; scripts/ufc-aptos-listings.mjs scans Rarible
-- marketplace::list / bundles::list_bundle transfers in UFC collections (price/seller from the tx's Listed event) and
-- re-checks liveness (a listing is live while the token is still owned by its listing object). v_ufc_aptos_edition_floor
-- gives the per-edition floor for the edition page "UFC ASK" and an FMV ask ceiling. Plan: claude/ufc-reopen-on-aptos-plan-2026-11-16.md.
-- Revert: DROP VIEW public.v_ufc_aptos_edition_floor; DROP TABLE public.ufc_aptos_listings;
--         ALTER TABLE public.ufc_aptos_ingest_state DROP COLUMN listings_scanned_through_version;
CREATE TABLE public.ufc_aptos_listings (
  listing_address      text PRIMARY KEY,
  token_data_id        text NOT NULL,
  aptos_collection_id  text NOT NULL,
  edition_id           uuid REFERENCES public.editions(id),
  serial_number        integer,
  kind                 text NOT NULL CHECK (kind IN ('single','bundle')),
  marketplace          text NOT NULL DEFAULT 'rarible',
  price_apt            numeric,          -- per token for 'single'; NULL for 'bundle' (one price for the whole bundle)
  bundle_price_apt     numeric,
  seller               text,
  listed_version       bigint NOT NULL,
  listed_at            timestamptz NOT NULL,
  last_checked_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ufc_aptos_listings_edition_idx ON public.ufc_aptos_listings (edition_id);
CREATE INDEX ufc_aptos_listings_token_idx ON public.ufc_aptos_listings (token_data_id);
ALTER TABLE public.ufc_aptos_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ufc_aptos_listings FROM anon, authenticated;
COMMENT ON TABLE public.ufc_aptos_listings IS
  'Live UFC Strike listings on Aptos (Rarible). One row per listing object; rows are removed when the token leaves the listing (sold/delisted). Written by scripts/ufc-aptos-listings.mjs.';

CREATE VIEW public.v_ufc_aptos_edition_floor WITH (security_invoker = on) AS
SELECT l.edition_id,
       min(l.price_apt) FILTER (WHERE l.kind = 'single')                         AS floor_apt,
       round(min(l.price_apt) FILTER (WHERE l.kind = 'single') * px.usd, 2)      AS floor_usd,
       count(*) FILTER (WHERE l.kind = 'single')                                 AS single_listings,
       count(*) FILTER (WHERE l.kind = 'bundle')                                 AS bundled_tokens,
       count(DISTINCT l.seller)                                                  AS sellers,
       max(l.last_checked_at)                                                    AS checked_at,
       px.day                                                                    AS apt_usd_day
  FROM public.ufc_aptos_listings l
  CROSS JOIN LATERAL (SELECT day, usd FROM public.apt_usd_daily ORDER BY day DESC LIMIT 1) px
 WHERE l.edition_id IS NOT NULL
 GROUP BY l.edition_id, px.usd, px.day;
REVOKE ALL ON public.v_ufc_aptos_edition_floor FROM anon, authenticated;

ALTER TABLE public.ufc_aptos_ingest_state ADD COLUMN IF NOT EXISTS listings_scanned_through_version bigint;
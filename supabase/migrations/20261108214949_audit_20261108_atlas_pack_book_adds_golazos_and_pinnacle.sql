-- audit_20261108_atlas_pack_book_adds_golazos_and_pinnacle — 2026-11-08 (Cowork cloud, ~1:50 PM PT, applied on Trevor's 1:49 PM "Yes do it all";
-- Trevor: "Then we need to make sure packs are included across all supported collections").
--
-- The Atlas pack book (atlas_pack_market, 20261101022135) walked only 'nba' and 'nfl'. Probed from
-- pg_net 11-08 1:45 PM PT, the same public SearchDistributions endpoint answers 200 for
-- product 'laliga' (LaLiga Golazos — first row dist 235 "Jornadas 1-9") and 'disney' (Disney
-- Pinnacle — first row dist 8913 "A Disney Villains Halloween Vol.2", a drop RPC's
-- pack_distributions does not have: its newest Pinnacle dist is 8906). 'golazos', 'pinnacle' and
-- 'ufc' are refused (Cloudflare 403), so they are not the product keys.
--
-- WHAT. Widen both product CHECKs and add a state row per new product. atlas_pack_market_tick()
-- already iterates atlas_pack_market_state rows (verified prosrc: no product literal), so it walks
-- the new products from its next minute; atlas_pack_market_request_page() sends origin
-- nbatopshot.com for any product that is not 'nfl', which is what the probe used and got 200.
-- No function changes; the pinned bodies (supabase/tests/atlas_pack_market_tick.sql) are untouched.
-- Readers: atlas_pack_book(p_product) is called for 'nba'/'nfl' only; the pack calendar
-- (lib/insights/pack-calendar.ts) reads the new products in the same commit.
--
-- REVERT:
--   DELETE FROM public.atlas_pack_market WHERE product IN ('laliga', 'disney');
--   DELETE FROM public.atlas_pack_market_state WHERE product IN ('laliga', 'disney');
--   then restore both CHECKs to product IN ('nba', 'nfl').

ALTER TABLE public.atlas_pack_market DROP CONSTRAINT atlas_pack_market_product_check;
ALTER TABLE public.atlas_pack_market
  ADD CONSTRAINT atlas_pack_market_product_check CHECK (product IN ('nba', 'nfl', 'laliga', 'disney'));

ALTER TABLE public.atlas_pack_market_state DROP CONSTRAINT atlas_pack_market_state_product_check;
ALTER TABLE public.atlas_pack_market_state
  ADD CONSTRAINT atlas_pack_market_state_product_check CHECK (product IN ('nba', 'nfl', 'laliga', 'disney'));

INSERT INTO public.atlas_pack_market_state (product) VALUES ('laliga'), ('disney') ON CONFLICT DO NOTHING;

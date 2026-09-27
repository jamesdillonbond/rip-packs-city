-- audit_20260927_panini_owner_cards
--
-- Panini Collection tab backend (2026-09-27, Candy/Panini parity). A Panini owner is a USERNAME
-- (lib/address.ts isPaniniUsername), not an address, so the shared Collection tab — keyed on a
-- wallet in wallet_moments_cache, where Panini has zero rows — cannot serve it.
--
-- What RPC can honestly say about a username is what panini_card_serials SAW under it: the walk
-- reads a card's holder when it reads the card, and it reads a card only once the card has been
-- LISTED. Measured 2026-09-27: 2,552 of 3,266 owners appear ONLY through their own listings.
-- So this is "cards seen under this username", never "this collector's collection", and the
-- payload carries the counts the tab needs to say so (seen / listed now / seen unlisted /
-- last seen). A card sold since its last read can still sit under its previous holder.
--
-- One jsonb: { username, cards_seen, listed_now, editions, special_serials, fmv_seen_usd,
-- fmv_priced_cards, last_seen_at, cards[] (top p_limit by edition FMV) }. FMV per card is the
-- EDITION's current FMV (edition_fmv_current over the bridged editions row); a card whose
-- edition has none is counted, not priced as $0.
--
-- anon-exec: revoked below — service-role only, like panini_set_progress (public.panini_owner_cards)

CREATE OR REPLACE FUNCTION public.panini_owner_cards(p_username text, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH mine AS (
    SELECT s.sku, s.edition_external_id, s.serial_number, s.mint_cap, s.is_listed, s.price_usd,
           s.last_sale_usd, s.last_sale_at, s.captured_at,
           s.is_number_one, s.is_jersey_mint, s.is_perfect_mint, s.is_special
    FROM panini_card_serials s
    WHERE p_username IS NOT NULL AND s.owner <> '' AND lower(s.owner) = lower(btrim(p_username))
  ), priced AS (
    SELECT m.*, pe.player_name, pe.set_name, pe.tier::text AS tier,
           public.panini_asset_url(pe.thumbnail_url) AS thumbnail_url,
           f.fmv_usd, f.confidence::text AS confidence
    FROM mine m
    LEFT JOIN panini_editions pe ON pe.external_id = m.edition_external_id
    LEFT JOIN editions e
      ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b' AND e.external_id = m.edition_external_id
    LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
  )
  SELECT jsonb_build_object(
    'username',         lower(btrim(p_username)),
    'cards_seen',       (SELECT count(*) FROM priced),
    'listed_now',       (SELECT count(*) FROM priced WHERE is_listed),
    'editions',         (SELECT count(DISTINCT edition_external_id) FROM priced),
    'special_serials',  (SELECT count(*) FROM priced WHERE is_special),
    'fmv_seen_usd',     (SELECT round(sum(fmv_usd), 2) FROM priced WHERE fmv_usd > 0),
    'fmv_priced_cards', (SELECT count(*) FROM priced WHERE fmv_usd > 0),
    'last_seen_at',     (SELECT max(captured_at) FROM priced),
    'cards', COALESCE((
      SELECT jsonb_agg(to_jsonb(c.*) ORDER BY c.fmv_usd DESC NULLS LAST, c.sku)
      FROM (
        SELECT sku, edition_external_id, serial_number, mint_cap, is_listed, price_usd AS ask_usd,
               last_sale_usd, last_sale_at, captured_at, is_number_one, is_jersey_mint,
               is_perfect_mint, player_name, set_name, tier, thumbnail_url, fmv_usd, confidence
        FROM priced
        ORDER BY fmv_usd DESC NULLS LAST, sku
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
      ) c
    ), '[]'::jsonb)
  )
$$;

COMMENT ON FUNCTION public.panini_owner_cards(text, int) IS
  'Panini Collection tab: cards RPC has SEEN under a username (listing-gated; point-in-time holder), with counts and edition FMV. Not a census of the collector''s holdings.';

REVOKE ALL ON FUNCTION public.panini_owner_cards(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_owner_cards(text, int) TO service_role;

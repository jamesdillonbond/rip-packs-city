-- audit_20261108_candy_retire_listings_owner_moved
--
-- PHANTOM CANDY ASKS, second class: a listing whose SELLER NO LONGER OWNS the token.
--
-- Measured 2026-11-08 ~10:40 AM PT. Candy locked every minted NFT on 10-12 (SOL drained
-- from its custodial wallets), then moved every NFT into new per-user MoonPay wallets
-- (10-19 → ~10-24) and said all marketplace listings were being cancelled. Magic Eden's
-- listings endpoint never noticed: it still returns the pre-migration asks with
-- `token.owner = seller` (e.g. mint 2592xTJH…: ME says owner E1zN…, our on-chain DAS
-- census says 3QGq…). The 3-hourly sweep kept re-seeing them, so the 12 h "confirmed"
-- gate treated them as live:
--   candy_listings       1,498 active; 1,480 for tokens whose census owner ≠ seller
--                        (124 editions, median $3.71). 0 listings first seen since 10-12.
--   candy_pack_listings  23 active; 23 owner ≠ seller.
-- They fed the Market tab, % Listed, candy_listing_floor (confirmed floor → FMV ceiling and
-- ask corroboration), candy_edition_market_daily, the Spreads/Deals boards, the
-- "cheapest listing on Magic Eden" CTA and the concierge deal search.
--
-- Evidence standard (unchanged from the indexer's): deactivate only on POSITIVE evidence.
-- Here it is the daily on-chain census (Helius DAS getAssetsByGroup → wallet_moments_cache /
-- candy_packs, escrow-held tokens already re-attributed to their listing's seller), and only
-- when that census walk happened AFTER we first saw the listing — `w.last_seen_at >
-- l.first_seen_at`. A brand-new listing by a buyer the census has not caught up with yet is
-- therefore never touched; it is judged at the next walk.
--
-- `owner_moved_at` marks a retired row so the indexer does not re-activate it on the next
-- sweep (ME keeps returning it). If the census later shows the seller owning the token again,
-- the mark is cleared and the indexer's next sweep restores the row.
--
-- candy_edition_market_daily: every day it holds (10-26 → 11-08) was recorded off this book,
-- after the migration — floors and listed counts were phantom. floor_ask_usd → NULL (unknown,
-- not a value); listed_count → NULL (the column is made nullable for this; readers render NULL as
-- "—"). Offers are untouched.
-- Backup of the overwritten values: audit_20261108_candy_market_daily_backup (RLS on).
--
-- anon-exec: intentional — new function, REVOKEd from PUBLIC/anon/authenticated below; called by the service-role indexer only (candy_retire_listings_owner_moved)
-- anon-exec: intentional — new function, REVOKEd from PUBLIC/anon/authenticated below; called by the service-role indexer only (candy_listing_owner_moved_pdas)
--
-- Rollback:
--   UPDATE candy_listings      SET is_active = true, owner_moved_at = NULL WHERE owner_moved_at IS NOT NULL;
--   UPDATE candy_pack_listings SET is_active = true, owner_moved_at = NULL WHERE owner_moved_at IS NOT NULL;
--   UPDATE candy_edition_market_daily d SET floor_ask_usd = b.floor_ask_usd, listed_count = b.listed_count
--     FROM audit_20261108_candy_market_daily_backup b WHERE b.edition_id = d.edition_id AND b.day = d.day;
--   ALTER TABLE candy_edition_market_daily ALTER COLUMN listed_count SET NOT NULL;
--   DROP FUNCTION public.candy_retire_listings_owner_moved();
--   DROP FUNCTION public.candy_listing_owner_moved_pdas(text[]);
--   ALTER TABLE candy_listings DROP COLUMN owner_moved_at; ALTER TABLE candy_pack_listings DROP COLUMN owner_moved_at;
--   (and git revert the indexer change, or it will query a missing column)

ALTER TABLE public.candy_listings      ADD COLUMN IF NOT EXISTS owner_moved_at timestamptz;
ALTER TABLE public.candy_pack_listings ADD COLUMN IF NOT EXISTS owner_moved_at timestamptz;

COMMENT ON COLUMN public.candy_listings.owner_moved_at IS
  'Set when the on-chain census (walked after this listing was first seen) shows a different owner than the seller: the ask cannot fill. The indexer will not re-activate a row while this is set. Cleared if the seller owns the token again. audit_20261108.';
COMMENT ON COLUMN public.candy_pack_listings.owner_moved_at IS
  'As candy_listings.owner_moved_at, against candy_packs.owner. audit_20261108.';

CREATE OR REPLACE FUNCTION public.candy_retire_listings_owner_moved()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cards integer;
  v_packs integer;
  v_cards_cleared integer;
  v_packs_cleared integer;
BEGIN
  UPDATE candy_listings l
     SET is_active = false,
         owner_moved_at = COALESCE(l.owner_moved_at, now())
    FROM wallet_moments_cache w
   WHERE l.is_active
     AND w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.moment_id = l.token_mint
     AND l.seller IS NOT NULL
     AND w.wallet_address <> l.seller
     AND w.last_seen_at > l.first_seen_at;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  UPDATE candy_pack_listings pl
     SET is_active = false,
         owner_moved_at = COALESCE(pl.owner_moved_at, now())
    FROM candy_packs p
   WHERE pl.is_active
     AND p.token_mint = pl.token_mint
     AND pl.seller IS NOT NULL
     AND p.owner IS NOT NULL
     AND p.owner <> pl.seller
     AND p.last_seen_at > pl.first_seen_at;
  GET DIAGNOSTICS v_packs = ROW_COUNT;

  -- The seller owns it again (census confirmed): lift the mark; the next sweep restores it.
  UPDATE candy_listings l
     SET owner_moved_at = NULL
    FROM wallet_moments_cache w
   WHERE l.owner_moved_at IS NOT NULL
     AND w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.moment_id = l.token_mint
     AND w.wallet_address = l.seller
     AND w.last_seen_at > l.owner_moved_at;
  GET DIAGNOSTICS v_cards_cleared = ROW_COUNT;

  UPDATE candy_pack_listings pl
     SET owner_moved_at = NULL
    FROM candy_packs p
   WHERE pl.owner_moved_at IS NOT NULL
     AND p.token_mint = pl.token_mint
     AND p.owner = pl.seller
     AND p.last_seen_at > pl.owner_moved_at;
  GET DIAGNOSTICS v_packs_cleared = ROW_COUNT;

  RETURN jsonb_build_object(
    'cards_retired', v_cards, 'packs_retired', v_packs,
    'cards_cleared', v_cards_cleared, 'packs_cleared', v_packs_cleared);
END;
$$;

REVOKE ALL ON FUNCTION public.candy_retire_listings_owner_moved() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_retire_listings_owner_moved() TO service_role;

-- Per-page lookup for the indexer: which of these listing accounts are retired for a moved
-- owner (cards and packs). An RPC rather than a table read so a page costs one round trip.
CREATE OR REPLACE FUNCTION public.candy_listing_owner_moved_pdas(p_pdas text[])
RETURNS TABLE (pda_address text, seller text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT l.pda_address, l.seller FROM candy_listings l
   WHERE l.pda_address = ANY (p_pdas) AND l.owner_moved_at IS NOT NULL
  UNION ALL
  SELECT pl.pda_address, pl.seller FROM candy_pack_listings pl
   WHERE pl.pda_address = ANY (p_pdas) AND pl.owner_moved_at IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.candy_listing_owner_moved_pdas(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_listing_owner_moved_pdas(text[]) TO service_role;

-- History built off the phantom book.
CREATE TABLE IF NOT EXISTS public.audit_20261108_candy_market_daily_backup AS
  SELECT edition_id, day, floor_ask_usd, listed_count, now() AS backed_up_at
    FROM public.candy_edition_market_daily
   WHERE day >= DATE '2026-10-26';
ALTER TABLE public.audit_20261108_candy_market_daily_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261108_candy_market_daily_backup FROM PUBLIC, anon, authenticated;

-- The repair (runs once here; the indexer calls the function every tick from now on).
SELECT public.candy_retire_listings_owner_moved();

ALTER TABLE public.candy_edition_market_daily ALTER COLUMN listed_count DROP NOT NULL;

UPDATE public.candy_edition_market_daily
   SET floor_ask_usd = NULL, listed_count = NULL
 WHERE day >= DATE '2026-10-26' AND day <= DATE '2026-11-08';

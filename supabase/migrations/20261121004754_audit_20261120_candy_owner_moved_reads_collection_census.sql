-- audit_20261120_candy_owner_moved_reads_collection_census
--
-- PHANTOM CANDY ASKS on the LEGACY collections: the owner-moved retirer could never reach them.
--
-- Measured 2026-11-20 ~5:00 PM PT (Claude Code cloud; Trevor: "work autonomously ... fix any issues
-- you encounter"). Of 10,156 active Magic Eden Candy asks, 9,619 have a census holder <> seller, in a
-- near-perfect 1:1 holder<->seller pairing (697 holders, 646 sellers, 698 pairs). The sellers are the
-- PRE-MIGRATION custody wallets: 325 of the 646 sold Candy before the 10-12 lock, 0 of the holders
-- did, and since trading reopened the holders sell (5) while the sellers do not (1). These are the
-- asks Magic Eden kept serving after Candy moved every card to new per-user wallets (10-19 -> 10-24)
-- — the class 20261108183038 retires — on the ~318 non-registry ("legacy") collections that
-- lib/candy/collections-market.ts started writing to candy_listings on 11-14.
--
-- WHY THE RETIRER MISSED THEM. Its evidence gate is `w.last_seen_at > l.first_seen_at`: the census
-- must have re-seen the holder after we first saw the ask. The registry census rewrites last_seen_at;
-- the LEGACY census (lib/candy/collections-census.ts) is INSERT-ONLY — an unchanged holding is never
-- rewritten, so its last_seen_at stays at the walk that first inserted it (Blackest Night (2009-2010)
-- #1: walked 5:58 AM PT 11-20, its 520 holder rows' newest last_seen_at is 11-16). Every legacy ask
-- first seen after its holder's insert was unreachable for ever.
--
-- WHAT. One more way to meet the SAME evidence standard: the card's collection census COMPLETED after
-- we first saw the ask. The legacy census keeps one row per card for its latest observed owner (a
-- move inserts the new owner's row and the end-of-run ghost purge drops the old one; escrow-held
-- listed cards are attributed to the listing's seller), so a completed walk that still shows a holder
-- <> seller is positive evidence the seller did not own the card when the walk ran. Conservative:
--   * only a walk that started AND finished in one run (candy_collections.last_census_items IS NOT
--     NULL — the census writes it only then) with no recorded error;
--   * and last_census_at > first_seen_at + 20 minutes (a run is at most 800 s), so every page of
--     that walk was read after the ask first appeared.
-- Everything else in the function is unchanged (packs, the clear path, the return shape). The clear
-- path already works for the legacy census: a card that moves back to the seller gets a NEW row with
-- last_seen_at = now(), which is > owner_moved_at.
--
-- Sized before writing (same predicate as below): 9,354 active asks would retire, 641 sellers,
-- $16.2M of listed "value"; 8,273 of them are asks by wallets that sold Candy before the lock and 0
-- by any wallet that has sold since trading reopened. Asks whose holder IS the seller (536) are
-- untouched by construction. Takes effect at the next candy-listings-indexer run (its caller).
--
-- NOT done here: candy_edition_market_daily rows recorded off the phantom book since 11-14 (floors /
-- listed counts on legacy editions) are left as they are; the 11-08 migration nulled its own window.
--
-- PIN: supabase/tests/candy_retire_listings_owner_moved.sql (verbatim; drift-guarded).
-- anon-exec: unchanged — REVOKEd from PUBLIC/anon/authenticated below; called by the service-role indexer only (candy_retire_listings_owner_moved)
-- Revert: re-apply the function body from 20261108183038_audit_20261108_candy_retire_listings_owner_moved.sql
--   (prosrc md5 8477763a242150c84dcd3fcfd6070a4c). Rows retired by the new arm:
--   UPDATE candy_listings SET is_active = true, owner_moved_at = NULL
--    WHERE owner_moved_at >= '<apply time>' AND venue = 'magic_eden';  (then the next sweep re-judges them)

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
  -- Evidence: a census walk that ran AFTER we first saw the ask shows another owner. Either the
  -- holder row itself was (re)written after first_seen (registry census), or the card's legacy
  -- collection completed a single-run walk after first_seen + 20 min (legacy census, insert-only:
  -- an unchanged holding keeps its old last_seen_at). 20261120 widened the second arm.
  UPDATE candy_listings l
     SET is_active = false,
         owner_moved_at = COALESCE(l.owner_moved_at, now())
    FROM wallet_moments_cache w
   WHERE l.is_active
     AND w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.moment_id = l.token_mint
     AND l.seller IS NOT NULL
     AND w.wallet_address <> l.seller
     AND (w.last_seen_at > l.first_seen_at
          OR EXISTS (SELECT 1
                       FROM editions e
                       JOIN candy_collections c ON c.set_id = e.set_id
                      WHERE e.id = l.edition_id
                        AND c.last_census_items IS NOT NULL
                        AND c.last_census_error IS NULL
                        AND c.last_census_at > l.first_seen_at + interval '20 minutes'));
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

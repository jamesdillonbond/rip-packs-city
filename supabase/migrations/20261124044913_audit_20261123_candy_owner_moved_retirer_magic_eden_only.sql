-- audit_20261123_candy_owner_moved_retirer_magic_eden_only
-- The OpenSea on-chain listings lane (2026-11-23) writes candy_listings rows with venue 'opensea'. OpenSea's
-- Solana program ESCROWS the card: a live ask's Core asset is owned by its ListState account, so the census
-- holder is never the seller and both retire arms of candy_retire_listings_owner_moved() would retire every
-- live OpenSea ask on the Magic Eden indexer's next run (and the lane would re-raise it an hour later).
-- Scope both RETIRE arms to venue 'magic_eden' (every row today: 1,479 active / 18,399 inactive, all
-- magic_eden — no behaviour change at apply time). OpenSea asks are confirmed and retired by their own lane.
-- Pin: supabase/tests/candy_retire_listings_owner_moved.sql (adds an escrowed OpenSea case that must stay live).
-- Revert: re-apply the body from 20261121012809_audit_20261120_candy_owner_moved_census_arm_own_statement.sql.
-- anon-exec: unchanged (candy_retire_listings_owner_moved) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false 11-23.

CREATE OR REPLACE FUNCTION public.candy_retire_listings_owner_moved()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cards integer;
  v_cards_census integer;
  v_packs integer;
  v_cards_cleared integer;
  v_packs_cleared integer;
BEGIN
  -- Evidence: a census walk that ran AFTER we first saw the ask shows another owner.
  -- MAGIC EDEN asks only (11-23): an OpenSea ask ESCROWS the card — its on-chain owner is the ListState
  -- account, never the seller — so "census holder <> seller" is TRUE of every live OpenSea ask. Those
  -- rows are confirmed hourly by their own lane (asset owner = ListState) and retired there.
  -- (1) The holder row itself was (re)written after first_seen (registry census) — the 11-08 rule,
  --     unchanged, so it keeps its per-ask index plan.
  UPDATE candy_listings l
     SET is_active = false,
         owner_moved_at = COALESCE(l.owner_moved_at, now())
    FROM wallet_moments_cache w
   WHERE l.is_active
     AND l.venue = 'magic_eden'
     AND w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.moment_id = l.token_mint
     AND l.seller IS NOT NULL
     AND w.wallet_address <> l.seller
     AND w.last_seen_at > l.first_seen_at;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  -- (2) The card's LEGACY collection completed a walk that began after first_seen (the legacy census is
  --     insert-only: an unchanged holding keeps its old last_seen_at, so (1) can never see it). A
  --     single-run walk (last_census_items set) began at most one run (800 s) before it completed, so
  --     completed > first_seen + 20 min proves it; a clean multi-run walk records its start. A SEPARATE
  --     statement with plain joins on purpose: OR-ing this into (1) as an EXISTS turned the per-ask index
  --     probe into a hash join over all ~1.37M Candy holdings (56k -> 370k buffers, measured 11-20).
  UPDATE candy_listings l
     SET is_active = false,
         owner_moved_at = COALESCE(l.owner_moved_at, now())
    FROM editions e, candy_collections c, wallet_moments_cache w
   WHERE l.is_active
     AND l.venue = 'magic_eden'
     AND l.seller IS NOT NULL
     AND e.id = l.edition_id
     AND c.set_id = e.set_id
     AND c.last_census_error IS NULL
     AND ((c.last_census_items IS NOT NULL AND c.last_census_at > l.first_seen_at + interval '20 minutes')
          OR c.last_census_clean_walk_started_at > l.first_seen_at)
     AND w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.moment_id = l.token_mint
     AND w.wallet_address <> l.seller;
  GET DIAGNOSTICS v_cards_census = ROW_COUNT;
  v_cards := v_cards + v_cards_census;

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
    'cards_retired', v_cards, 'cards_retired_by_collection_census', v_cards_census, 'packs_retired', v_packs,
    'cards_cleared', v_cards_cleared, 'packs_cleared', v_packs_cleared);
END;
$$;

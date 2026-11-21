-- audit_20261120_candy_owner_moved_census_arm_own_statement
--
-- Same session as 20261121004754 / 20261121010254 (Claude Code cloud, ~5:35 PM PT 2026-11-20).
--
-- COST REGRESSION FIX in my own two migrations above. Measured after applying them (EXPLAIN ANALYZE of the
-- retire predicate as a SELECT, cold):
--   11-08 predicate alone        nested loop, per-ask index probe     56k buffers   5.2 s
--   20261121010254 (OR + EXISTS)  hash join over all 1.37M Candy wmc  370k buffers  17.2 s
--   census arm as its own join   nested loop                          68k buffers   1.3 s (9,350 rows)
-- The correctness probe I ran before shipping was silent about cost (CLAUDE.md, measurement discipline).
--
-- WHAT: the 11-08 UPDATE is restored byte-for-byte as statement (1); the collection-census evidence is a
-- separate UPDATE (2) with plain joins. Same rows retired (both statements count into cards_retired), plus a
-- new key cards_retired_by_collection_census so the new arm is visible on its own. The indexer reads only
-- the four original keys, so the extra key is additive. Packs and the clear path unchanged.
--
-- PIN: supabase/tests/candy_retire_listings_owner_moved.sql (re-pinned to this file).
-- anon-exec: unchanged — REVOKEd from PUBLIC/anon/authenticated below; called by the service-role indexer only (candy_retire_listings_owner_moved)
-- Revert: re-apply the body from 20261121010254_audit_20261120_candy_owner_moved_multi_run_walks.sql
--   (prosrc md5 fb1bca5ff2a18b0176217804eecbe0d0) — same rows, the slower plan.

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
  -- (1) The holder row itself was (re)written after first_seen (registry census) — the 11-08 rule,
  --     unchanged, so it keeps its per-ask index plan.
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

REVOKE ALL ON FUNCTION public.candy_retire_listings_owner_moved() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_retire_listings_owner_moved() TO service_role;

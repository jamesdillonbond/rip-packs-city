-- audit_20261125_candy_owner_moved_clear_bounded_to_returned_asks
--
-- 2026-11-25 ~8:00 AM PT (Claude Code, attended; Trevor: "Keep going").
-- WHY. candy-listings-indexer failed 2 of its 3 runs today (1:35 AM, 7:35 AM PT) on
-- "owner-moved retire: canceling statement due to statement timeout" — 0 such failures 11-22..11-24.
-- Timed each statement of candy_retire_listings_owner_moved() read-only (EXPLAIN ANALYZE of the SELECT form):
--   (1) registry arm            ~8.6k buffers, 1.1 s
--   (2) collection-census arm   ~9.8k buffers, 2.1 s
--   (3)/(5) pack statements      <100 buffers
--   (4) CARD MARK CLEAR         59.6k buffers, 14.9 s cold  <- the cost
-- (4) probes wallet_moments_cache for EVERY candy_listings row ever marked owner-moved: 11,700 rows today
-- (all inactive; oldest mark 11-08) against 1,622 active asks, and the set only grows (~700/day).
-- The mark has ONE reader: the indexer skips a returned ask whose pda+seller carry it (owner_moved_skipped,
-- ~1,751 per run). Lifting the mark on an ask Magic Eden no longer returns changes nothing; if ME returns it
-- later it is skipped that run, its mark is judged then, and the next sweep restores it.
-- WHAT. New optional parameter p_returned_pdas: the PDAs the indexer skipped as owner-moved THIS run. When
-- given, statement (4) only judges those (PK lookup); NULL keeps the old unbounded statement, so the old
-- route (no argument) behaves exactly as before during the deploy window. Branch, not `p IS NULL OR ...`,
-- so the bounded form keeps a pda_address index plan under plpgsql's generic plan.
-- Retire arms (1)-(3) and the pack clear (5) are byte-identical.
-- One behavioural delta, stated: a marked ask whose seller regains the card WHILE ME is not returning it is
-- restored one sweep (3 h) later than before (judged on the run ME returns it, restored on the next).
-- anon-exec: intentional — signature change; REVOKEd from PUBLIC/anon/authenticated below, service_role only (candy_retire_listings_owner_moved)
-- REVERT: re-apply supabase/migrations/20261124044913_audit_20261123_candy_owner_moved_retirer_magic_eden_only.sql
--   after `DROP FUNCTION public.candy_retire_listings_owner_moved(text[]);` (and revert the route, which then
--   sends an argument the old signature lacks).

DROP FUNCTION IF EXISTS public.candy_retire_listings_owner_moved();

CREATE OR REPLACE FUNCTION public.candy_retire_listings_owner_moved(p_returned_pdas text[] DEFAULT NULL)
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
  -- 11-25: judged only for the asks ME returned this run (p_returned_pdas) — the mark's only reader is the
  -- indexer's skip of a RETURNED ask, and the ever-marked set (11.7k, growing) timed this statement out.
  IF p_returned_pdas IS NULL THEN
    UPDATE candy_listings l
       SET owner_moved_at = NULL
      FROM wallet_moments_cache w
     WHERE l.owner_moved_at IS NOT NULL
       AND w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND w.moment_id = l.token_mint
       AND w.wallet_address = l.seller
       AND w.last_seen_at > l.owner_moved_at;
  ELSE
    UPDATE candy_listings l
       SET owner_moved_at = NULL
      FROM wallet_moments_cache w
     WHERE l.pda_address = ANY (p_returned_pdas)
       AND l.owner_moved_at IS NOT NULL
       AND w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND w.moment_id = l.token_mint
       AND w.wallet_address = l.seller
       AND w.last_seen_at > l.owner_moved_at;
  END IF;
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

REVOKE ALL ON FUNCTION public.candy_retire_listings_owner_moved(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_retire_listings_owner_moved(text[]) TO service_role;

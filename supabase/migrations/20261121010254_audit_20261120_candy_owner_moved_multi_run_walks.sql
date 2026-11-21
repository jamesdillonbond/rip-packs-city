-- audit_20261120_candy_owner_moved_multi_run_walks
--
-- Follow-up to 20261121004754 (same session, Claude Code cloud, ~5:20 PM PT 2026-11-20; Trevor: "work
-- autonomously ... fix any issues you encounter").
--
-- 20261121004754 lets the owner-moved retirer accept a LEGACY collection census as evidence, but only a
-- walk that started and finished in one run (last_census_items NOT NULL — the only walks whose start
-- time could be inferred). ~265 phantom pre-migration asks sit in collections whose last walk spanned
-- several runs, so they could never be judged — about a third of the legacy book left after the 7:35
-- PM PT retirement.
--
-- WHAT.
--   1. candy_collections.last_census_clean_walk_started_at — when the last CLEAN walk began: tracked
--      from its start, no card skipped, label record intact (the same condition the census already
--      requires before its own RETIRE step). Written by lib/candy/collections-census.ts at walk
--      completion (NULL for a walk that was not clean). NULL for every row until the next walk of each
--      collection completes, so this arm is inert until then.
--   2. candy_retire_listings_owner_moved(): the legacy arm also accepts
--      last_census_clean_walk_started_at > first_seen_at — every page of that walk was read after the
--      ask first appeared. The single-run proxy stays.
--
-- PIN: supabase/tests/candy_retire_listings_owner_moved.sql (re-pinned to this file).
-- anon-exec: unchanged — REVOKEd from PUBLIC/anon/authenticated below; called by the service-role indexer only (candy_retire_listings_owner_moved)
-- Revert: re-apply the function body from 20261121004754_audit_20261120_candy_owner_moved_reads_collection_census.sql
--   (prosrc md5 86ab8bee2deecf706798e1cd8742e568), then
--   ALTER TABLE public.candy_collections DROP COLUMN last_census_clean_walk_started_at;  (after the census
--   commit that writes it is reverted)

ALTER TABLE public.candy_collections ADD COLUMN IF NOT EXISTS last_census_clean_walk_started_at timestamptz;
COMMENT ON COLUMN public.candy_collections.last_census_clean_walk_started_at IS
  'Start of the last CLEAN completed census walk (tracked from its start, no card skipped). NULL when the last walk was not clean. Writer: lib/candy/collections-census.ts. Reader: candy_retire_listings_owner_moved (20261120).';

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
  -- collection completed a walk that began after first_seen (legacy census, insert-only: an
  -- unchanged holding keeps its old last_seen_at). 20261121004754 added the single-run proxy
  -- (completed > first_seen + 20 min); audit_20261120_candy_owner_moved_multi_run_walks added the recorded start of a clean multi-run walk.
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
                        AND c.last_census_error IS NULL
                        AND ((c.last_census_items IS NOT NULL
                              AND c.last_census_at > l.first_seen_at + interval '20 minutes')
                             OR c.last_census_clean_walk_started_at > l.first_seen_at)));
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

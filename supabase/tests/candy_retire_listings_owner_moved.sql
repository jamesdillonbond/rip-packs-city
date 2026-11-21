-- DB invariant: public.candy_retire_listings_owner_moved() — 2026-11-20.
-- The property: an active Candy ask is retired (is_active=false, owner_moved_at stamped) only on
-- POSITIVE census evidence that the seller did not own the card AFTER we first saw the ask:
--   (a) the holder row was (re)written after first_seen_at (registry census), or
--   (b) the card's legacy collection completed a SINGLE-RUN walk (last_census_items NOT NULL, no
--       error) more than 20 minutes after first_seen_at (legacy census is insert-only, so an
--       unchanged holding keeps its old last_seen_at — the 9.6k phantom asks of 11-20).
-- Never retired: holder = seller; a walk too close to first_seen; a multi-run walk; an errored walk.
-- A card back with its seller lifts the mark.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261121004754_audit_20261120_candy_owner_moved_reads_collection_census.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, set_id uuid);
CREATE TABLE public.candy_collections (set_id uuid, last_census_at timestamptz, last_census_items int, last_census_error text);
CREATE TABLE public.wallet_moments_cache (collection_id uuid, wallet_address text, moment_id text, last_seen_at timestamptz);
CREATE TABLE public.candy_listings (pda_address text PRIMARY KEY, token_mint text, edition_id uuid, seller text,
  is_active boolean, first_seen_at timestamptz, owner_moved_at timestamptz);
CREATE TABLE public.candy_packs (token_mint text, owner text, last_seen_at timestamptz);
CREATE TABLE public.candy_pack_listings (pda_address text PRIMARY KEY, token_mint text, seller text,
  is_active boolean, first_seen_at timestamptz, owner_moved_at timestamptz);

-- >>> BEGIN verbatim candy_retire_listings_owner_moved >>>
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
-- <<< END verbatim candy_retire_listings_owner_moved <<<

\set CANDY '''209ade70-32c5-4470-bc7c-4793d660f713'''
-- sets: S1 single-run walk 2 h after first_seen; S2 walk only 10 min after; S3 multi-run (items NULL);
--       S4 errored walk; S5 no walk since first_seen.
INSERT INTO public.candy_collections VALUES
  ('10000000-0000-0000-0000-000000000001', now() - interval '1 hour',      520,  NULL),
  ('10000000-0000-0000-0000-000000000002', now() - interval '2 hours 50 minutes', 520, NULL),
  ('10000000-0000-0000-0000-000000000003', now() - interval '1 hour',      NULL, NULL),
  ('10000000-0000-0000-0000-000000000004', now() - interval '1 hour',      520,  'das 500'),
  ('10000000-0000-0000-0000-000000000005', now() - interval '5 hours',     520,  NULL);
INSERT INTO public.editions VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004'),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000005');
-- Every legacy holder row is OLD (inserted 2 days ago, never rewritten); every ask first seen 3 h ago.
INSERT INTO public.wallet_moments_cache VALUES
  (:CANDY::uuid, 'NEWWALLET', 'M_PHANTOM',  now() - interval '2 days'),  -- S1, holder <> seller  -> RETIRED (new arm)
  (:CANDY::uuid, 'NEWWALLET', 'M_TOOCLOSE', now() - interval '2 days'),  -- S2, walk 10 min after -> kept
  (:CANDY::uuid, 'NEWWALLET', 'M_MULTIRUN', now() - interval '2 days'),  -- S3, multi-run walk    -> kept
  (:CANDY::uuid, 'NEWWALLET', 'M_ERRORED',  now() - interval '2 days'),  -- S4, errored walk      -> kept
  (:CANDY::uuid, 'NEWWALLET', 'M_NOWALK',   now() - interval '2 days'),  -- S5, no walk since     -> kept
  (:CANDY::uuid, 'SELLER',    'M_OWNED',    now() - interval '2 days'),  -- S1, holder = seller   -> kept
  (:CANDY::uuid, 'BUYER',     'M_REGISTRY', now() - interval '1 hour'),  -- S5, row rewritten after first_seen -> RETIRED (old arm)
  (:CANDY::uuid, 'SELLER',    'M_BACK',     now() - interval '5 minutes'); -- marked earlier, now back with seller -> mark lifted
INSERT INTO public.candy_listings VALUES
  ('P_PHANTOM',  'M_PHANTOM',  '20000000-0000-0000-0000-000000000001', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_TOOCLOSE', 'M_TOOCLOSE', '20000000-0000-0000-0000-000000000002', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_MULTIRUN', 'M_MULTIRUN', '20000000-0000-0000-0000-000000000003', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_ERRORED',  'M_ERRORED',  '20000000-0000-0000-0000-000000000004', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_NOWALK',   'M_NOWALK',   '20000000-0000-0000-0000-000000000005', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_OWNED',    'M_OWNED',    '20000000-0000-0000-0000-000000000001', 'SELLER',     true, now() - interval '3 hours', NULL),
  ('P_REGISTRY', 'M_REGISTRY', '20000000-0000-0000-0000-000000000005', 'SELLER',     true, now() - interval '3 hours', NULL),
  ('P_BACK',     'M_BACK',     '20000000-0000-0000-0000-000000000001', 'SELLER',     false, now() - interval '3 days', now() - interval '1 day');

DO $t$
DECLARE v jsonb;
BEGIN
  v := public.candy_retire_listings_owner_moved();
  PERFORM _assert_eq(v->>'cards_retired', '2', 'exactly the legacy phantom (new arm) and the registry-evidence ask (old arm) retire');
  PERFORM _assert_eq(v->>'cards_cleared', '1', 'a card back with its seller lifts the mark');
  PERFORM _assert((SELECT NOT is_active AND owner_moved_at IS NOT NULL FROM public.candy_listings WHERE pda_address = 'P_PHANTOM'),
    'a completed single-run legacy walk > 20 min after first_seen showing another holder retires the ask, though the holder row is OLD');
  PERFORM _assert((SELECT NOT is_active FROM public.candy_listings WHERE pda_address = 'P_REGISTRY'), 'the original arm still works');
  PERFORM _assert((SELECT bool_and(is_active AND owner_moved_at IS NULL) FROM public.candy_listings
                    WHERE pda_address IN ('P_TOOCLOSE','P_MULTIRUN','P_ERRORED','P_NOWALK','P_OWNED')),
    '⚠ never retired: walk within 20 min of first_seen, multi-run walk, errored walk, no walk since, or holder = seller');
  PERFORM _assert((SELECT owner_moved_at IS NULL FROM public.candy_listings WHERE pda_address = 'P_BACK'), 'mark lifted');
END
$t$;

ROLLBACK;

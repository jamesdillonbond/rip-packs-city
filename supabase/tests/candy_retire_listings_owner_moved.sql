-- DB invariant: public.candy_retire_listings_owner_moved() — 2026-11-20.
-- The property: an active Candy ask is retired (is_active=false, owner_moved_at stamped) only on
-- POSITIVE census evidence that the seller did not own the card AFTER we first saw the ask:
--   (a) the holder row was (re)written after first_seen_at (registry census), or
--   (b) the card's legacy collection completed a SINGLE-RUN walk (last_census_items NOT NULL, no
--       error) more than 20 minutes after first_seen_at (legacy census is insert-only, so an
--       unchanged holding keeps its old last_seen_at — the 9.6k phantom asks of 11-20), or
--   (c) its last CLEAN multi-run walk STARTED after first_seen_at (last_census_clean_walk_started_at).
-- Never retired: holder = seller; a walk too close to first_seen; a multi-run walk with no clean start
-- recorded, or one that began before first_seen; an errored walk.
-- A card back with its seller lifts the mark.
-- 11-23: only Magic Eden asks are judged — an OpenSea ask escrows the card (holder = its ListState, never the
-- seller), so it is never retired here; its own lane confirms the escrow hourly.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261125154323_audit_20261125_candy_owner_moved_clear_bounded_to_returned_asks.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, set_id uuid);
CREATE TABLE public.candy_collections (set_id uuid, last_census_at timestamptz, last_census_items int, last_census_error text,
  last_census_clean_walk_started_at timestamptz);
CREATE TABLE public.wallet_moments_cache (collection_id uuid, wallet_address text, moment_id text, last_seen_at timestamptz);
CREATE TABLE public.candy_listings (pda_address text PRIMARY KEY, token_mint text, edition_id uuid, seller text,
  is_active boolean, first_seen_at timestamptz, owner_moved_at timestamptz, venue text NOT NULL DEFAULT 'magic_eden');
CREATE TABLE public.candy_packs (token_mint text, owner text, last_seen_at timestamptz);
CREATE TABLE public.candy_pack_listings (pda_address text PRIMARY KEY, token_mint text, seller text,
  is_active boolean, first_seen_at timestamptz, owner_moved_at timestamptz);

-- >>> BEGIN verbatim candy_retire_listings_owner_moved >>>
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

-- <<< END verbatim candy_retire_listings_owner_moved <<<

\set CANDY '''209ade70-32c5-4470-bc7c-4793d660f713'''
-- sets: S1 single-run walk 2 h after first_seen; S2 walk only 10 min after; S3 multi-run (items NULL, no
--       clean start recorded); S4 errored walk; S5 no walk since first_seen; S6 clean multi-run walk that
--       began 1 h after first_seen; S7 clean multi-run walk that began 1 h BEFORE first_seen.
INSERT INTO public.candy_collections VALUES
  ('10000000-0000-0000-0000-000000000001', now() - interval '1 hour',      520,  NULL, NULL),
  ('10000000-0000-0000-0000-000000000002', now() - interval '2 hours 50 minutes', 520, NULL, NULL),
  ('10000000-0000-0000-0000-000000000003', now() - interval '1 hour',      NULL, NULL, NULL),
  ('10000000-0000-0000-0000-000000000004', now() - interval '1 hour',      520,  'das 500', NULL),
  ('10000000-0000-0000-0000-000000000005', now() - interval '5 hours',     520,  NULL, NULL),
  ('10000000-0000-0000-0000-000000000006', now() - interval '1 hour',      NULL, NULL, now() - interval '2 hours'),  -- clean multi-run, began after first_seen
  ('10000000-0000-0000-0000-000000000007', now() - interval '1 hour',      NULL, NULL, now() - interval '4 hours');  -- clean multi-run, began BEFORE first_seen
INSERT INTO public.editions VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004'),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000005'),
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000006'),
  ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000007');
-- Every legacy holder row is OLD (inserted 2 days ago, never rewritten); every ask first seen 3 h ago.
INSERT INTO public.wallet_moments_cache VALUES
  (:CANDY::uuid, 'NEWWALLET', 'M_PHANTOM',  now() - interval '2 days'),  -- S1, holder <> seller  -> RETIRED (new arm)
  (:CANDY::uuid, 'NEWWALLET', 'M_TOOCLOSE', now() - interval '2 days'),  -- S2, walk 10 min after -> kept
  (:CANDY::uuid, 'NEWWALLET', 'M_MULTIRUN', now() - interval '2 days'),  -- S3, multi-run walk    -> kept
  (:CANDY::uuid, 'NEWWALLET', 'M_ERRORED',  now() - interval '2 days'),  -- S4, errored walk      -> kept
  (:CANDY::uuid, 'NEWWALLET', 'M_NOWALK',   now() - interval '2 days'),  -- S5, no walk since     -> kept
  (:CANDY::uuid, 'NEWWALLET', 'M_MULTICLEAN', now() - interval '2 days'), -- S6, clean multi-run after -> RETIRED
  (:CANDY::uuid, 'NEWWALLET', 'M_MULTIEARLY', now() - interval '2 days'), -- S7, clean multi-run before -> kept
  (:CANDY::uuid, 'SELLER',    'M_OWNED',    now() - interval '2 days'),  -- S1, holder = seller   -> kept
  (:CANDY::uuid, 'BUYER',     'M_REGISTRY', now() - interval '1 hour'),  -- S5, row rewritten after first_seen -> RETIRED (old arm)
  (:CANDY::uuid, 'SELLER',    'M_BACK',     now() - interval '5 minutes'), -- marked earlier, now back with seller -> mark lifted
  (:CANDY::uuid, 'OS_LISTSTATE', 'M_OPENSEA', now() - interval '1 hour');  -- OpenSea escrow: holder <> seller, rewritten after first_seen, S1 walk -> kept
INSERT INTO public.candy_listings VALUES
  ('P_PHANTOM',  'M_PHANTOM',  '20000000-0000-0000-0000-000000000001', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_TOOCLOSE', 'M_TOOCLOSE', '20000000-0000-0000-0000-000000000002', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_MULTIRUN', 'M_MULTIRUN', '20000000-0000-0000-0000-000000000003', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_ERRORED',  'M_ERRORED',  '20000000-0000-0000-0000-000000000004', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_NOWALK',   'M_NOWALK',   '20000000-0000-0000-0000-000000000005', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_MULTICLEAN', 'M_MULTICLEAN', '20000000-0000-0000-0000-000000000006', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_MULTIEARLY', 'M_MULTIEARLY', '20000000-0000-0000-0000-000000000007', 'OLDCUSTODY', true, now() - interval '3 hours', NULL),
  ('P_OWNED',    'M_OWNED',    '20000000-0000-0000-0000-000000000001', 'SELLER',     true, now() - interval '3 hours', NULL),
  ('P_REGISTRY', 'M_REGISTRY', '20000000-0000-0000-0000-000000000005', 'SELLER',     true, now() - interval '3 hours', NULL),
  ('P_BACK',     'M_BACK',     '20000000-0000-0000-0000-000000000001', 'SELLER',     false, now() - interval '3 days', now() - interval '1 day');
INSERT INTO public.candy_listings VALUES
  ('OS_LISTSTATE', 'M_OPENSEA', '20000000-0000-0000-0000-000000000001', 'SELLER', true, now() - interval '3 hours', NULL, 'opensea');

DO $t$
DECLARE v jsonb;
BEGIN
  v := public.candy_retire_listings_owner_moved();
  PERFORM _assert_eq(v->>'cards_retired_by_collection_census', '2', 'the collection-census statement retires the two legacy phantoms and reports them on their own');
  PERFORM _assert_eq(v->>'cards_retired', '3', 'exactly the single-run legacy phantom, the clean multi-run legacy phantom and the registry-evidence ask retire');
  PERFORM _assert((SELECT NOT is_active FROM public.candy_listings WHERE pda_address = 'P_MULTICLEAN'),
    'a clean multi-run walk that BEGAN after first_seen retires the ask');
  PERFORM _assert_eq(v->>'cards_cleared', '1', 'a card back with its seller lifts the mark');
  PERFORM _assert((SELECT NOT is_active AND owner_moved_at IS NOT NULL FROM public.candy_listings WHERE pda_address = 'P_PHANTOM'),
    'a completed single-run legacy walk > 20 min after first_seen showing another holder retires the ask, though the holder row is OLD');
  PERFORM _assert((SELECT NOT is_active FROM public.candy_listings WHERE pda_address = 'P_REGISTRY'), 'the original arm still works');
  PERFORM _assert((SELECT bool_and(is_active AND owner_moved_at IS NULL) FROM public.candy_listings
                    WHERE pda_address IN ('P_TOOCLOSE','P_MULTIRUN','P_ERRORED','P_NOWALK','P_OWNED','P_MULTIEARLY')),
    '⚠ never retired: walk within 20 min of first_seen, multi-run walk with no clean start, a clean walk that began before first_seen, errored walk, no walk since, or holder = seller');
  PERFORM _assert((SELECT owner_moved_at IS NULL FROM public.candy_listings WHERE pda_address = 'P_BACK'), 'mark lifted');
  PERFORM _assert((SELECT is_active AND owner_moved_at IS NULL FROM public.candy_listings WHERE pda_address = 'OS_LISTSTATE'),
    '⚠ an escrowed OpenSea ask is never retired here, though both arms'' evidence (holder <> seller, rewritten after first_seen, a completed walk) holds for it');
END
$t$;

-- 11-25: the card mark clear is judged only for the asks the indexer was RETURNED this run (p_returned_pdas).
-- Two marked asks, both back with their seller; only P_BACK_RETURNED is in the returned set.
INSERT INTO public.wallet_moments_cache VALUES
  (:CANDY::uuid, 'SELLER', 'M_BACK_RETURNED', now() - interval '5 minutes'),
  (:CANDY::uuid, 'SELLER', 'M_BACK_UNSEEN',   now() - interval '5 minutes');
INSERT INTO public.candy_listings VALUES
  ('P_BACK_RETURNED', 'M_BACK_RETURNED', '20000000-0000-0000-0000-000000000001', 'SELLER', false, now() - interval '3 days', now() - interval '1 day'),
  ('P_BACK_UNSEEN',   'M_BACK_UNSEEN',   '20000000-0000-0000-0000-000000000001', 'SELLER', false, now() - interval '3 days', now() - interval '1 day');

DO $t$
DECLARE v jsonb;
BEGIN
  v := public.candy_retire_listings_owner_moved(ARRAY[]::text[]);
  PERFORM _assert_eq(v->>'cards_cleared', '0', '⚠ an EMPTY returned set clears nothing — it is not NULL, which would judge every mark');
  PERFORM _assert((SELECT bool_and(owner_moved_at IS NOT NULL) FROM public.candy_listings WHERE pda_address IN ('P_BACK_RETURNED','P_BACK_UNSEEN')),
    'both marks survive an empty returned set');

  v := public.candy_retire_listings_owner_moved(ARRAY['P_BACK_RETURNED']);
  PERFORM _assert_eq(v->>'cards_cleared', '1', 'only the returned ask is judged');
  PERFORM _assert((SELECT owner_moved_at IS NULL FROM public.candy_listings WHERE pda_address = 'P_BACK_RETURNED'),
    'a returned ask back with its seller has its mark lifted');
  PERFORM _assert((SELECT owner_moved_at IS NOT NULL FROM public.candy_listings WHERE pda_address = 'P_BACK_UNSEEN'),
    '⚠ an ask ME did not return keeps its mark — judged on the run it is returned');
END
$t$;

ROLLBACK;

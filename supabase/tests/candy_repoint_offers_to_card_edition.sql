-- DB invariant: public.candy_repoint_offers_to_card_edition(text[]) — 2026-11-09.
-- (2026-11-12: mirrored from candy_repoint_listings_to_card_edition.sql — same fixtures, on candy_offers.)
-- The property: a Candy offer follows its CARD — every candy_offers row for a given token_mint
-- (active or retired, any venue) moves to the edition the card's NEWEST holdings row names; a listing
-- already on that edition, a mint not asked about, another collection's row and a mint with no
-- holdings row are untouched; the return value counts rows actually moved.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261113044929_audit_20261112_candy_offers_follow_their_card.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.wallet_moments_cache (wallet_address text, collection_id uuid, moment_id text, edition_key text, last_seen_at timestamptz);
CREATE TABLE public.candy_offers (pda_address text PRIMARY KEY, token_mint text, edition_id uuid, collection_id uuid, is_active boolean, venue text);

-- >>> BEGIN verbatim candy_repoint_offers_to_card_edition (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.candy_repoint_offers_to_card_edition(p_mints text[])
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A Candy OFFER follows its CARD (2026-11-12, twin of candy_repoint_listings_to_card_edition): every
  -- candy_offers row for a token_mint (any venue, active or expired) moves to the edition the card's NEWEST
  -- holdings row names. Offers are per token like listings, but nothing moved them when the census
  -- repointed a card off a fabricated name-only edition, so 263 historical bids kept 43 emptied #246
  -- editions "referenced" and the orphan cleanup could not retire them. A mint with no holdings row is
  -- never guessed. Returns rows moved.
  WITH cur AS (
    SELECT DISTINCT ON (w.moment_id) w.moment_id, e.id AS edition_id
      FROM public.wallet_moments_cache w
      JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND w.moment_id = ANY (p_mints)
     ORDER BY w.moment_id, w.last_seen_at DESC NULLS LAST
  ), moved AS (
    UPDATE public.candy_offers l
       SET edition_id = cur.edition_id
      FROM cur
     WHERE l.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND l.token_mint = cur.moment_id
       AND l.edition_id IS DISTINCT FROM cur.edition_id
    RETURNING 1
  )
  SELECT count(*)::int FROM moved
$function$;
-- <<< END verbatim candy_repoint_offers_to_card_edition <<<

\set CANDY '''209ade70-32c5-4470-bc7c-4793d660f713'''
\set TS    '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', :CANDY::uuid, 'c:leadoff:phil-bickford'),        -- fabricated (old)
  ('00000000-0000-0000-0000-0000000000a2', :CANDY::uuid, 'c:leadoff:phil-bickford-core'),   -- real (new)
  ('00000000-0000-0000-0000-0000000000a3', :CANDY::uuid, 'c:leadoff:josh-core'),
  ('00000000-0000-0000-0000-0000000000a4', :CANDY::uuid, 'c:leadoff:stale-owner-key');
INSERT INTO public.wallet_moments_cache VALUES
  ('W1', :CANDY::uuid, 'mint-1', 'c:leadoff:phil-bickford-core', now()),                   -- card repointed
  ('W0', :CANDY::uuid, 'mint-1', 'c:leadoff:stale-owner-key',   now() - interval '2 days'), -- older owner row: ignored
  ('W2', :CANDY::uuid, 'mint-2', 'c:leadoff:josh-core', now());                              -- already in step
INSERT INTO public.candy_offers VALUES
  ('pda-1', 'mint-1', '00000000-0000-0000-0000-0000000000a1', :CANDY::uuid, false, 'magic_eden'),  -- retired ask on the OLD edition -> MOVED
  ('pda-2', 'mint-1', '00000000-0000-0000-0000-0000000000a1', :CANDY::uuid, true,  'opensea'),     -- active, other venue        -> MOVED
  ('pda-3', 'mint-2', '00000000-0000-0000-0000-0000000000a3', :CANDY::uuid, true,  'magic_eden'),  -- in step                    -> untouched
  ('pda-4', 'mint-3', '00000000-0000-0000-0000-0000000000a1', :CANDY::uuid, false, 'magic_eden'),  -- no holdings row            -> untouched
  ('pda-5', 'mint-9', '00000000-0000-0000-0000-0000000000a1', :CANDY::uuid, false, 'magic_eden'),  -- not asked about            -> untouched
  ('pda-6', 'mint-1', '00000000-0000-0000-0000-0000000000a1', :TS::uuid,    false, 'magic_eden');  -- another collection        -> untouched

DO $$
DECLARE n int;
BEGIN
  n := public.candy_repoint_offers_to_card_edition(ARRAY['mint-1', 'mint-2', 'mint-3']);
  PERFORM _assert_eq(n::text, '2', 'exactly the two rows of the repointed card moved');
  PERFORM _assert((SELECT bool_and(edition_id = '00000000-0000-0000-0000-0000000000a2') FROM public.candy_offers WHERE pda_address IN ('pda-1', 'pda-2')),
                  '⚠ a RETIRED ask moves with its card, to the edition its NEWEST holdings row names');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a3' FROM public.candy_offers WHERE pda_address = 'pda-3'), 'an in-step listing is untouched');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a1' FROM public.candy_offers WHERE pda_address = 'pda-4'), 'a mint with no holdings row is untouched (never guessed)');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a1' FROM public.candy_offers WHERE pda_address = 'pda-5'), 'a mint not asked about is untouched');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a1' FROM public.candy_offers WHERE pda_address = 'pda-6'), 'another collection''s row is untouched');
  n := public.candy_repoint_offers_to_card_edition(ARRAY['mint-1']);
  PERFORM _assert_eq(n::text, '0', 'a second call moves nothing');
END $$;

ROLLBACK;

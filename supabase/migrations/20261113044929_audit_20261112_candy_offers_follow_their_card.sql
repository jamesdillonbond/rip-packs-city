-- audit_20261112_candy_offers_follow_their_card
--
-- 2026-11-12 ~8:55 PM PT (Claude Code cloud; scheduled check-in on Trevor's "Work through and get those figured
-- out"). edition_integrity_flags 313: of 46 label-less Candy editions no card holds any more, the orphan
-- cleanup (candy_delete_orphan_name_only_editions, hourly :37) skipped 43 because a candy_offers row names
-- them — 264 offers, all inactive, 263 of them for tokens whose card the census has since repointed to its
-- real edition (1 token has no holdings row). Listings already follow their card
-- (candy_repoint_listings_to_card_edition, 20261110044500); offers never did.
--   (1) candy_repoint_offers_to_card_edition(p_mints): the listings function mirrored onto candy_offers.
--   (2) Backfill: every offer AND listing on a label-less Candy edition is re-pointed through the two
--       functions (a token with no holdings row is left where it is). The census calls (1) beside the
--       listings call from now on (lib/candy/collections-census.ts).
--
-- PIN: supabase/tests/candy_repoint_offers_to_card_edition.sql
-- REVERT: DROP FUNCTION public.candy_repoint_offers_to_card_edition(text[]); the moved offers stay on the
--   card's real edition (their correct home); the pre-move edition ids are in the NOTICE of this migration's
--   apply only — not restored.

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

REVOKE EXECUTE ON FUNCTION public.candy_repoint_offers_to_card_edition(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_repoint_offers_to_card_edition(text[]) TO service_role;

DO $backfill$
DECLARE v_mints text[]; v_off int; v_lst int; v_left int;
BEGIN
  SELECT array_agg(DISTINCT m) INTO v_mints FROM (
    SELECT o.token_mint AS m FROM public.candy_offers o JOIN public.editions e ON e.id = o.edition_id
     WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' AND e.thumbnail_url IS NULL
    UNION
    SELECT l.token_mint FROM public.candy_listings l JOIN public.editions e ON e.id = l.edition_id
     WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' AND e.thumbnail_url IS NULL
  ) x WHERE m IS NOT NULL;
  v_off := public.candy_repoint_offers_to_card_edition(coalesce(v_mints, ARRAY[]::text[]));
  v_lst := public.candy_repoint_listings_to_card_edition(coalesce(v_mints, ARRAY[]::text[]));
  SELECT count(*) INTO v_left FROM public.candy_offers o JOIN public.editions e ON e.id = o.edition_id
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' AND e.thumbnail_url IS NULL;
  RAISE NOTICE 'offers moved %, listings moved %, offers left on label-less editions %', v_off, v_lst, v_left;
  IF v_off < 250 THEN RAISE EXCEPTION 'expected ~263 offers to move, moved %', v_off; END IF;
  IF v_left > 5 THEN RAISE EXCEPTION 'expected <= 5 offers left on label-less editions, %', v_left; END IF;
END
$backfill$;

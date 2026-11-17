-- 2026-10-26 (Candy ↔ Top Shot parity): two edition-page reads Candy was missing.
--
-- 1. get_edition_offers — the Offers half of an edition's Activity block read ONLY
--    public.offers (the Flow OffersV2 feed). Candy's standing bids live in
--    public.candy_offers (Magic Eden), so every Candy edition's Offers tab said
--    "no offers" over a live bid book. This adds a Candy arm with the SAME active
--    predicate candy_best_offers uses (is_active AND not expired); each bid is on a
--    specific token, so its serial comes from the census row for that mint
--    (wallet_moments_cache, scoped by collection — a moment_id is unique only
--    within a collection, #142). The Flow arms are unchanged and a Flow edition
--    matches no candy_offers row (edition_id is the edition's own uuid).
--
-- 2. get_candy_edition_top_owners — Top Shot's "Top Owners" section reads
--    get_edition_top_owners (topshot_ownership). Candy's wallet_moments_cache is a
--    FULL daily on-chain census (25,375 rows = 25,375 minted, measured 10-26), so
--    the same section is exact for Candy. Excluded, as on candy_holder_board:
--    Candy's issuer treasury (candy_treasury_wallet — unsold pack inventory, not a
--    collection) and candy_holder_board_exclusions (the Magic Eden listing escrow).
--    Same return shape as get_edition_top_owners so the page renders one block.

CREATE OR REPLACE FUNCTION public.get_edition_offers(p_edition_id uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  WITH ed AS MATERIALIZED (
    SELECT id, external_id, collection_id,
           (external_id LIKE '%::%') AS is_sub,
           split_part(external_id, '::', 1) AS base_ext
    FROM editions WHERE id = p_edition_id
  ),
  base_ed AS MATERIALIZED (
    SELECT b.id FROM editions b JOIN ed ON b.collection_id = ed.collection_id AND b.external_id = ed.base_ext
    WHERE ed.is_sub
  ),
  recent AS (
    SELECT u.serial_number, u.price_usd, u.buyer_address, u.offer_type, u.made_at
    FROM (
      (SELECT o.serial_number,
              o.offer_amount_usd    AS price_usd,
              o.buyer_address::text AS buyer_address,
              o.offer_type::text    AS offer_type,
              o.created_at          AS made_at
         FROM public.offers o
        WHERE o.edition_id = (SELECT ed.id FROM ed)
          AND o.status = 'open'
          AND o.offer_amount_usd > 0
        ORDER BY o.offer_amount_usd DESC, o.created_at DESC
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100))
      UNION ALL
      (SELECT o.serial_number,
              o.offer_amount_usd    AS price_usd,
              o.buyer_address::text AS buyer_address,
              o.offer_type::text    AS offer_type,
              o.created_at          AS made_at
         FROM public.offers o
        WHERE o.edition_id IN (SELECT base_ed.id FROM base_ed)
          AND o.offer_type = 'edition'
          AND o.status = 'open'
          AND o.offer_amount_usd > 0
        ORDER BY o.offer_amount_usd DESC, o.created_at DESC
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100))
      UNION ALL
      -- Candy MLB (Magic Eden bids, 2026-10-26): same active predicate as candy_best_offers.
      (SELECT w.serial_number,
              c.price_usd           AS price_usd,
              c.buyer               AS buyer_address,
              'serial'::text        AS offer_type,
              -- Magic Eden reports no bid creation time; first_seen_at is when OUR sweep first
              -- saw it, which for a bid older than the lane would read as "made then". Unknown
              -- is rendered as unknown (—), never as our own observation time.
              NULL::timestamptz     AS made_at
         FROM public.candy_offers c
         LEFT JOIN public.wallet_moments_cache w
           ON w.collection_id = c.collection_id AND w.moment_id = c.token_mint
        WHERE c.edition_id = (SELECT ed.id FROM ed)
          AND c.is_active
          AND (c.expiry IS NULL OR c.expiry > now())
          AND c.price_usd > 0
        ORDER BY c.price_usd DESC, c.first_seen_at DESC
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100))
    ) u
    ORDER BY u.price_usd DESC, u.made_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(recent.*) ORDER BY recent.price_usd DESC), '[]'::jsonb)
  FROM recent;
$function$;
-- anon-exec: unchanged (get_edition_offers) — CREATE OR REPLACE of an existing fn; ACL preserved (has_function_privilege anon = false, read 2026-10-26).

CREATE OR REPLACE FUNCTION public.get_candy_edition_top_owners(p_edition_id uuid, p_limit integer DEFAULT 10)
 RETURNS TABLE(owner_address text, moment_count integer, low_serial integer, total_holders integer, total_moments integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  WITH ed AS MATERIALIZED (
    SELECT external_id FROM public.editions
    WHERE id = p_edition_id AND collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  ),
  ex AS MATERIALIZED (
    SELECT wallet_address FROM public.candy_treasury_wallet
    UNION
    SELECT wallet_address FROM public.candy_holder_board_exclusions
  ),
  o AS MATERIALIZED (
    SELECT w.wallet_address, w.serial_number
    FROM public.wallet_moments_cache w
    WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
      AND w.edition_key = (SELECT external_id FROM ed)
      AND w.wallet_address NOT IN (SELECT wallet_address FROM ex)
  ),
  tot AS (
    SELECT count(DISTINCT wallet_address)::int AS holders, count(*)::int AS moments FROM o
  )
  SELECT o.wallet_address AS owner_address, count(*)::int AS moment_count, min(o.serial_number)::int AS low_serial,
         t.holders AS total_holders, t.moments AS total_moments
  FROM o CROSS JOIN tot t
  GROUP BY o.wallet_address, t.holders, t.moments
  ORDER BY count(*) DESC, min(o.serial_number) ASC NULLS LAST, o.wallet_address
  LIMIT greatest(1, least(COALESCE(p_limit, 10), 25));
$function$;
-- anon-exec: revoked (get_candy_edition_top_owners) — service-role only, like get_edition_top_owners (the edition page calls it server-side).
REVOKE EXECUTE ON FUNCTION public.get_candy_edition_top_owners(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_candy_edition_top_owners(uuid, integer) TO postgres, service_role;

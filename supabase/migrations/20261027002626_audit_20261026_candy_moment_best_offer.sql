-- 2026-10-26 (Candy ↔ Top Shot parity, second pass): a Candy card's moment page never
-- showed a best offer. get_moment_best_offer read only the Flow offer layers
-- (edition_offers, badge_editions, public.offers); Candy's bids are Magic Eden bids in
-- public.candy_offers, and every one of them targets ONE token (0 collection-level
-- bids, measured 10-26). So this adds a SERIAL-grain arm only: an active, unexpired bid
-- on the token whose census row (wallet_moments_cache, scoped by collection — a
-- moment_id is unique only within a collection, #142) carries this edition + serial.
-- Stamped with the bid's last_seen_at (the offers sweep re-confirmed it then).
--
-- Deliberately NOT done: an edition-level "Best offer" for Candy. A Candy bid is on one
-- copy, so an edition-grain figure would claim it is fillable by any serial — false.
-- The edition page's Offers tab lists the bids with their serials instead.
--
-- Flow arms unchanged (body re-read live 2026-10-26 immediately before this replace).

CREATE OR REPLACE FUNCTION public.get_moment_best_offer(p_edition_id uuid, p_serial integer)
 RETURNS TABLE(best_offer numeric, grain text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ed AS (
    SELECT id, external_id, collection_id,
           (external_id LIKE '%::%') AS is_sub,
           split_part(external_id, '::', 1) AS base_ext
    FROM editions WHERE id = p_edition_id
  )
  SELECT x.amt, x.grain, x.updated_at
  FROM (
    -- own GQL marketplace row: per-printing on :: editions, edition-wide on base.
    SELECT eo.highest_offer AS amt,
           CASE WHEN ed.is_sub THEN 'parallel' ELSE 'edition' END AS grain,
           eo.updated_at
    FROM ed
    JOIN edition_offers eo
      ON eo.external_id = ed.external_id AND eo.collection_id = ed.collection_id
    WHERE eo.highest_offer IS NOT NULL AND eo.highest_offer > 0
    UNION ALL
    SELECT be.highest_offer,
           CASE WHEN ed.is_sub THEN 'parallel' ELSE 'edition' END,
           be.updated_at
    FROM ed
    JOIN badge_editions be
      ON be.external_id = ed.external_id AND be.collection_id = ed.collection_id
    WHERE be.highest_offer IS NOT NULL AND be.highest_offer > 0
    UNION ALL
    -- on-chain subedition offers keyed to this :: edition (post 2026-07-07
    -- indexer fix / backfill).
    SELECT o.offer_amount_usd, 'parallel'::text, o.created_at
    FROM ed
    JOIN offers o ON o.edition_id = ed.id
    WHERE ed.is_sub
      AND o.status = 'open' AND o.offer_type = 'subedition'
      AND o.offer_amount_usd IS NOT NULL AND o.offer_amount_usd > 0
    UNION ALL
    -- base edition-grain on-chain offer — fillable by ANY printing, so a
    -- parallel moment is eligible for it too.
    SELECT o.offer_amount_usd, 'edition'::text, o.created_at
    FROM ed
    JOIN editions b ON b.collection_id = ed.collection_id AND b.external_id = ed.base_ext
    JOIN offers o ON o.edition_id = b.id
    WHERE ed.is_sub
      AND o.status = 'open' AND o.offer_type = 'edition'
      AND o.offer_amount_usd IS NOT NULL AND o.offer_amount_usd > 0
    UNION ALL
    -- serial-grain: an open offer targeting exactly this serial.
    SELECT o.offer_amount_usd, 'serial'::text, o.created_at
    FROM ed
    JOIN offers o ON o.edition_id = ed.id
    WHERE o.status = 'open' AND o.offer_type = 'serial'
      AND p_serial IS NOT NULL AND o.serial_number = p_serial
      AND o.offer_amount_usd IS NOT NULL AND o.offer_amount_usd > 0
    UNION ALL
    -- Candy MLB (2026-10-26): a Magic Eden bid on THIS token (serial-grain only).
    SELECT c.price_usd, 'serial'::text, c.last_seen_at
    FROM ed
    JOIN wallet_moments_cache w
      ON w.collection_id = ed.collection_id
     AND w.edition_key = ed.external_id
     AND w.serial_number = p_serial
    JOIN candy_offers c
      ON c.collection_id = ed.collection_id AND c.token_mint = w.moment_id
    WHERE ed.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
      AND p_serial IS NOT NULL
      AND c.is_active
      AND (c.expiry IS NULL OR c.expiry > now())
      AND c.price_usd IS NOT NULL AND c.price_usd > 0
  ) x
  ORDER BY x.amt DESC NULLS LAST
  LIMIT 1
$function$;
-- anon-exec: unchanged (get_moment_best_offer) — CREATE OR REPLACE of an existing fn; ACL preserved.

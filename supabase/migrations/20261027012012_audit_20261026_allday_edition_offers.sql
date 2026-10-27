-- audit_20261026: the edition Offers tab lists NFL All Day bids (All Day ↔ Top Shot parity pass, 2026-10-26 evening PT).
--
-- Every All Day edition page's Offers tab read "No open offers on this edition." — a false empty state: get_edition_offers
-- read public.offers (written only by the Top Shot indexer) and candy_offers, while All Day's OffersV2 EDITION bids live in
-- allday_open_offers (allday-offers-indexer, every ~20 min: insert on OfferAvailable, delete on OfferCompleted) and fed
-- only the single "Best offer" cell via edition_offers.highest_offer. 412 All Day market sales in the 7 days to 10-26 were
-- offer fills, so the bid book is a real part of this market.
--
-- Checked before shipping (~6:45 PM PT): allday_open_offers holds 5,009 open bids over 2,167 editions; max(amount) per
-- edition equals edition_offers.highest_offer on 2,167 of 2,167 (0 disagree), so the tab lists exactly the set the cell
-- summarises. Indexer: 72 runs / 24 h, 2 failed. The table keeps no bidder and no event time (updated_at = when the
-- indexer processed the event), so both render as unknown (—). Positive control: edition 4194 → 50 rows (106 open), top
-- $578 = its cell. Top Shot / Candy branches are textually unchanged; the new arm matches the All Day collection id only.
-- Live body diffed against prosrc before the replace (base = 20261026233730's Candy arm).
--
-- Revert: re-apply get_edition_offers from 20261026233730_audit_20261026_candy_edition_offers_and_top_owners.sql.

-- anon-exec: unchanged (get_edition_offers) — CREATE OR REPLACE of an existing fn; ACL preserved (has_function_privilege anon = false, read 2026-10-26 ~7:00 PM PT).
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
      UNION ALL
      -- NFL All Day (OffersV2 EDITION bids, 2026-10-26): the open set allday-offers-indexer keeps
      -- (insert on OfferAvailable, delete on OfferCompleted) — the same rows whose max() is the edition's
      -- "Best offer" cell (edition_offers.highest_offer; 2,167 of 2,167 editions agreed at ship). Edition
      -- scope: any serial fills it, so no serial. The table keeps neither the bidder nor the event time
      -- (updated_at is when the indexer processed it), so both render as unknown (—), never guessed.
      (SELECT NULL::integer         AS serial_number,
              a.amount              AS price_usd,
              NULL::text            AS buyer_address,
              'edition'::text       AS offer_type,
              NULL::timestamptz     AS made_at
         FROM public.allday_open_offers a
        WHERE a.edition_id = (SELECT ed.external_id FROM ed
                               WHERE ed.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070')
          AND a.amount > 0
        ORDER BY a.amount DESC, a.offer_id
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100))
    ) u
    ORDER BY u.price_usd DESC, u.made_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(recent.*) ORDER BY recent.price_usd DESC), '[]'::jsonb)
  FROM recent;
$function$;

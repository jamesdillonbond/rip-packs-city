-- audit_20261127_offer_spread_shows_only_bids_seen_in_24h — 2026-11-27 ~8:30 AM PT (Claude cloud session; Trevor: "Do it all").
--
-- THE DEFECT (Trevor, 11-27, drafting the Friday X post): the Bid vs Floor board showed Ace Bailey
-- Rookie Debut /99 (219:7423::17) with a $91 top offer against a $90.99 floor. Top Shot showed $68.
-- The $91 was last seen by Atlas on 2026-10-29 15:07Z, the last time that edition was walked; the
-- chain says that bid was CANCELLED 2026-11-10. sync_edition_offers_from_atlas() step (b) rewrites
-- highest_offer only for editions VERIFIED in the last 24 h, and raise_edition_offers_from_chain() is
-- RAISE-ONLY, so on every other edition the stored bid simply stands, for weeks. The row's updated_at
-- read "yesterday" because the FLOOR changed — it is a last-changed stamp for either side.
--
-- MEASURED before this file (Top Shot rows with both sides, 8,639): only 3,727 had a bid we can
-- evidence today (an open Atlas EDITION/PARALLEL offer at that exact price seen in 24 h: 1,263; or an
-- open chain edition offer at that amount: 2,894). Of the 303 rows the board flagged "bid meets ask",
-- NINE had that evidence. The board's headline signal was ~97% bids nobody can accept.
--
-- THE FIX (stamp + read-time gate; the same shape as best_offer_at / best_offer_at_amount, 20260915):
--   1. edition_offers.highest_offer_seen_at / _seen_amount: when the STORED highest_offer was last
--      observed open, and the amount that observation was for. Evidence, either:
--        • max(last_seen_at) of an open Atlas EDITION/PARALLEL offer event at exactly that price, or
--        • the stamp time, when an open on-chain EDITION offer at exactly that amount exists and is
--          not marketplace-hidden (#220: Atlas walked the edition after the bid and does not carry it).
--   2. pg_cron 'rpc-edition-offer-seen-stamp' at :08 and :38 re-stamps it (one UPDATE, no SET prefix;
--      ~7 s / 163k buffers cold, measured as a SELECT — per-row index probes, serial plan).
--   3. topshot_offer_ask_spread lists a row only while seen_amount = highest_offer AND seen_at is
--      within 24 h, and APPENDS offer_seen_at. Unknown is left off the board, never shown as a bid.
--      A bid that changes between stamps drops off for <= 30 min (fail closed).
-- No existing function body changes. Only the board reads this view (route, page, OG via
-- lib/insights/offer-spread-board.ts). Other bid surfaces (moment pages, checklists) still read the
-- unstamped column — follow-up filed in the ledger entry.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-edition-offer-seen-stamp');
--   re-apply the 20260915000248 view body (without offer_seen_at and the two seen_* predicates), then
--   ALTER VIEW public.topshot_offer_ask_spread SET (security_invoker = on);
--   (the two columns can stay; or ALTER TABLE public.edition_offers DROP COLUMN highest_offer_seen_at,
--    DROP COLUMN highest_offer_seen_amount — after the view no longer references them)

ALTER TABLE public.edition_offers
  ADD COLUMN IF NOT EXISTS highest_offer_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS highest_offer_seen_amount numeric;

COMMENT ON COLUMN public.edition_offers.highest_offer_seen_at IS
  'Top Shot: when the stored highest_offer was last OBSERVED open (Atlas offer event at that exact price, or an open non-hidden chain edition offer at that amount). Valid only while highest_offer_seen_amount = highest_offer. Stamped by pg_cron rpc-edition-offer-seen-stamp. audit_20261127.';
COMMENT ON COLUMN public.edition_offers.highest_offer_seen_amount IS
  'The highest_offer value highest_offer_seen_at was computed for. audit_20261127.';

-- First stamp, so the gated view does not go live empty. Same statement as the cron command below.
UPDATE public.edition_offers t
   SET highest_offer_seen_at = s.seen_at, highest_offer_seen_amount = s.highest_offer
  FROM (
    SELECT eo.external_id, eo.highest_offer, GREATEST(a.seen, c.seen) AS seen_at
      FROM public.edition_offers eo
      LEFT JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
      LEFT JOIN LATERAL (
        SELECT max(ev.last_seen_at) AS seen FROM public.topshot_atlas_market_events ev
         WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id AND ev.kind = 'offer' AND NOT ev.completed
           AND ev.offer_type IN ('EDITION','PARALLEL') AND ev.price_cents = (eo.highest_offer * 100)::bigint) a ON true
      LEFT JOIN LATERAL (
        SELECT now() AS seen
          FROM public.editions e2
          JOIN public.offers o ON o.edition_id = e2.id AND o.collection_id = e2.collection_id
         WHERE e2.collection_id = eo.collection_id AND e2.external_id::text = eo.external_id
           AND o.status = 'open' AND o.offer_type = 'edition' AND o.offer_amount_usd = eo.highest_offer
           AND NOT (EXISTS (SELECT 1 FROM public.topshot_atlas_edition_verified v
                             WHERE v.atlas_edition_id = m.atlas_edition_id AND v.verified_at > o.created_at)
                    AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev2
                             WHERE ev2.product = 'nba' AND ev2.atlas_edition_id = m.atlas_edition_id
                               AND ev2.kind = 'offer' AND NOT ev2.completed AND ev2.listing_resource_id = o.offer_id))
         LIMIT 1) c ON true
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.highest_offer > 0
  ) s
 WHERE t.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND t.external_id = s.external_id
   AND (t.highest_offer_seen_at IS DISTINCT FROM s.seen_at OR t.highest_offer_seen_amount IS DISTINCT FROM s.highest_offer);

-- Live definition re-read immediately before this (pg_get_viewdef, 2026-11-27 8:15 AM PT): the body
-- below is that definition plus the two seen_* predicates and one APPENDED column.
CREATE OR REPLACE VIEW public.topshot_offer_ask_spread AS
 SELECT e.external_id,
    e.name,
    e.player_name,
    e.set_name,
    e.tier,
    e.circulation_count,
    eo.highest_offer,
    eo.low_ask,
    round(eo.highest_offer / eo.low_ask * 100::numeric, 1) AS offer_pct_of_ask,
    round(abs(eo.highest_offer / eo.low_ask * 100::numeric - 100::numeric), 1) AS par_distance,
    round(eo.low_ask - eo.highest_offer, 2) AS spread_usd,
    eo.highest_offer >= eo.low_ask AS bid_meets_ask,
    eo.updated_at,
        CASE
            WHEN eo.best_offer_at_amount IS NOT NULL AND eo.best_offer_at_amount = eo.highest_offer THEN eo.best_offer_at
            ELSE NULL::timestamp with time zone
        END AS best_offer_at,
    -- When this exact bid was last seen open (see the column comment). Always within 24 h here.
    eo.highest_offer_seen_at AS offer_seen_at
   FROM edition_offers eo
     JOIN editions e ON e.external_id::text = eo.external_id AND e.collection_id = eo.collection_id
  WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.highest_offer > 0::numeric AND eo.low_ask > 0::numeric
    AND eo.highest_offer_seen_amount = eo.highest_offer
    AND eo.highest_offer_seen_at > now() - interval '24 hours'
  ORDER BY (round(abs(eo.highest_offer / eo.low_ask * 100::numeric - 100::numeric), 1));

-- Re-apply what CREATE OR REPLACE just reset.
ALTER VIEW public.topshot_offer_ask_spread SET (security_invoker = on);

GRANT SELECT ON public.topshot_offer_ask_spread TO anon, authenticated;

select cron.schedule('rpc-edition-offer-seen-stamp', '8,38 * * * *', $cmd$UPDATE public.edition_offers t
   SET highest_offer_seen_at = s.seen_at, highest_offer_seen_amount = s.highest_offer
  FROM (
    SELECT eo.external_id, eo.highest_offer, GREATEST(a.seen, c.seen) AS seen_at
      FROM public.edition_offers eo
      LEFT JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
      LEFT JOIN LATERAL (
        SELECT max(ev.last_seen_at) AS seen FROM public.topshot_atlas_market_events ev
         WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id AND ev.kind = 'offer' AND NOT ev.completed
           AND ev.offer_type IN ('EDITION','PARALLEL') AND ev.price_cents = (eo.highest_offer * 100)::bigint) a ON true
      LEFT JOIN LATERAL (
        SELECT now() AS seen
          FROM public.editions e2
          JOIN public.offers o ON o.edition_id = e2.id AND o.collection_id = e2.collection_id
         WHERE e2.collection_id = eo.collection_id AND e2.external_id::text = eo.external_id
           AND o.status = 'open' AND o.offer_type = 'edition' AND o.offer_amount_usd = eo.highest_offer
           AND NOT (EXISTS (SELECT 1 FROM public.topshot_atlas_edition_verified v
                             WHERE v.atlas_edition_id = m.atlas_edition_id AND v.verified_at > o.created_at)
                    AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev2
                             WHERE ev2.product = 'nba' AND ev2.atlas_edition_id = m.atlas_edition_id
                               AND ev2.kind = 'offer' AND NOT ev2.completed AND ev2.listing_resource_id = o.offer_id))
         LIMIT 1) c ON true
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.highest_offer > 0
  ) s
 WHERE t.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND t.external_id = s.external_id
   AND (t.highest_offer_seen_at IS DISTINCT FROM s.seen_at OR t.highest_offer_seen_amount IS DISTINCT FROM s.highest_offer)$cmd$);

-- audit_20261026: allday_offer_ask_spread — the All Day leg of the Bid vs Floor board (/insights/offer-spread)
-- (All Day ↔ Top Shot parity, 2026-10-26 evening PT).
--
-- Same column contract as topshot_offer_ask_spread. Bid = max open OffersV2 edition bid per edition
-- (allday_open_offers; = edition_offers.highest_offer on 2,167 of 2,167 editions, read 10-26). Ask = the verified
-- floor (allday_edition_floor_ask: ghost listings excluded) and updated_at = its floor_ask_verified_at — a CHECKED
-- stamp (askStampKind("nfl_all_day") = "checked"). best_offer_at NULL: the bid's time is not kept.
-- Read 10-26 ~7:20 PM PT: 1,356 editions with a bid and a floor; 1,008 with the floor ≥ $5 (the board's dust floor),
-- 63 of those with the bid ≥ 50 % of the floor; 4 crossed (bid ≥ floor) — each with a floor verified ~25 min earlier
-- and recent offer fills on the edition, so shown, with the board's existing "check before acting" copy.
-- Default board query (floor ≥ 5, par order, 200): 99 ms / 11.1k buffers warm.
-- Grants narrowed to service_role in the follow-up migration (every reader uses the service role).
--
-- Revert: DROP VIEW public.allday_offer_ask_spread;

CREATE OR REPLACE VIEW public.allday_offer_ask_spread WITH (security_invoker = on) AS
 SELECT e.external_id,
    e.name,
    e.player_name,
    e.set_name,
    e.tier,
    e.circulation_count,
    b.highest_offer,
    f.floor_ask AS low_ask,
    round(((b.highest_offer / f.floor_ask) * (100)::numeric), 1) AS offer_pct_of_ask,
    round(abs((((b.highest_offer / f.floor_ask) * (100)::numeric) - (100)::numeric)), 1) AS par_distance,
    round((f.floor_ask - b.highest_offer), 2) AS spread_usd,
    (b.highest_offer >= f.floor_ask) AS bid_meets_ask,
    f.floor_ask_verified_at AS updated_at,
    NULL::timestamp with time zone AS best_offer_at
   FROM (SELECT a.edition_id AS external_id, max(a.amount) AS highest_offer
           FROM public.allday_open_offers a
          WHERE a.amount > 0
          GROUP BY a.edition_id) b
     JOIN public.editions e ON e.external_id = b.external_id AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
     JOIN public.allday_edition_floor_ask f ON f.edition_id = e.id
  WHERE f.floor_ask > (0)::numeric;

REVOKE ALL ON public.allday_offer_ask_spread FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_offer_ask_spread TO anon, authenticated, service_role;

COMMENT ON VIEW public.allday_offer_ask_spread IS
  'NFL All Day Bid vs Floor (Top Shot parity, 2026-10-26): editions with an open OffersV2 edition bid (allday_open_offers, max per edition = edition_offers.highest_offer) AND a verified floor ask (allday_edition_floor_ask, ghost listings excluded). Same columns as topshot_offer_ask_spread; updated_at = floor_ask_verified_at (a CHECKED stamp); best_offer_at NULL (the bid time is not kept). audit_20261026.';

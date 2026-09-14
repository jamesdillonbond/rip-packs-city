-- audit_20260914: the offer/ask spread view exposes best_offer_at
--
-- Appends ONE column, read straight from edition_offers (precomputed by
-- sync_edition_offers_best_offer_at) so the view keeps its 80 ms / 4,357-buffer
-- baseline. See the previous migration for the three measurements behind that.
--
-- ⚠ CREATE OR REPLACE VIEW RESETS reloptions — security_invoker=on is re-applied
-- below in the SAME migration. Stripping it has happened 4x in this codebase and
-- would silently run the view as its OWNER for anon callers. It also cannot
-- rename or reorder columns (42P16), so best_offer_at is APPENDED last.
--
-- The live definition was re-read immediately before writing this (CREATE OR
-- REPLACE is a full-body write): the body below is that definition verbatim plus
-- the one column.
--
-- Verified after applying: reloptions = {security_invoker=on}, anon SELECT true,
-- 14 columns with best_offer_at last, and the view at 59 ms / 4,358 buffers AS
-- ANON (the production caller), against the 80 ms / 4,357 baseline.
--
-- REVERT: re-run this migration with the `eo.best_offer_at` line removed, then
--         ALTER VIEW public.topshot_offer_ask_spread SET (security_invoker = on);

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
    -- NULL = unageable, NEVER "new". See the column comment on edition_offers.
    eo.best_offer_at
   FROM edition_offers eo
     JOIN editions e ON e.external_id::text = eo.external_id AND e.collection_id = eo.collection_id
  WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.highest_offer > 0::numeric AND eo.low_ask > 0::numeric
  ORDER BY (round(abs(eo.highest_offer / eo.low_ask * 100::numeric - 100::numeric), 1));

-- Re-apply what CREATE OR REPLACE just reset.
ALTER VIEW public.topshot_offer_ask_spread SET (security_invoker = on);

GRANT SELECT ON public.topshot_offer_ask_spread TO anon, authenticated;

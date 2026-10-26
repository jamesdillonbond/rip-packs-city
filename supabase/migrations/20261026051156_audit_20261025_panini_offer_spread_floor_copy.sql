-- audit_20261025: Panini Bid vs Floor (Top Shot /insights/offer-spread parity), floor-copy definition
-- (Cowork cloud, 2026-10-25 ~10:15 PM PT; Trevor: "Keep going and do it all").
--
-- Per edition: the CHEAPEST LISTED COPY (ask re-read in 7 days — the same rule as panini_market_board) and the best
-- offer Panini shows on THAT copy, so the spread is on one card. Panini offers are per serial; an edition-wide best
-- offer is usually on a #1 or a low serial and is not a bid on a floor copy (the 20261026051029 definition, renamed
-- aside here). Measured at apply: 4,575 of 19,032 floors (ask >= $5) carry an offer, none above its ask, median offer
-- 22 % of the ask, 64 within 80 %. Refresh (refresh_panini_offer_spread, hourly at :38) 1.2 s, index-only on
-- idx_panini_serials_listed_edition_cover. Read by the Panini boards snapshot (lib/insights/panini-more-boards.ts).
--
-- Revert: SELECT cron.unschedule('panini-offer-spread'); then drop mv_panini_offer_spread,
--         mv_panini_offer_spread_v1_unused and refresh_panini_offer_spread(); git revert the code commit.

ALTER MATERIALIZED VIEW public.mv_panini_offer_spread RENAME TO mv_panini_offer_spread_v1_unused;
ALTER INDEX public.mv_panini_offer_spread_pk RENAME TO mv_panini_offer_spread_v1_unused_pk;
ALTER INDEX public.mv_panini_offer_spread_rank RENAME TO mv_panini_offer_spread_v1_unused_rank;
COMMENT ON MATERIALIZED VIEW public.mv_panini_offer_spread_v1_unused IS
  'SUPERSEDED 2026-10-25 by mv_panini_offer_spread (floor-copy definition, audit_20261025_panini_offer_spread_floor_copy). Unread and unrefreshed; safe to drop.';

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_offer_spread AS
WITH f AS (
  -- the cheapest listed copy per edition, ask re-read in 7 days — index-only on idx_panini_serials_listed_edition_cover
  SELECT DISTINCT ON (s.edition_external_id)
         s.edition_external_id AS external_id, s.sku, s.serial_number, s.mint_cap,
         s.price_usd AS ask_usd, s.best_offer_usd, s.captured_at
    FROM public.panini_card_serials s
   WHERE s.is_listed AND s.price_usd > 0 AND s.captured_at > now() - interval '7 days'
   ORDER BY s.edition_external_id, s.price_usd, s.sku
)
SELECT f.external_id,
       pe.player_name, pe.set_name, pe.parallel,
       coalesce(pe.mint_cap, f.mint_cap)                         AS mint_cap,
       pe.thumbnail_url,
       pp.name                                                   AS product_name,
       pp.last_grid_sport                                        AS sport,
       f.serial_number                                           AS floor_serial,
       f.ask_usd,
       f.best_offer_usd,
       nullif(sr.raw->>'offers_count', '')::int                  AS offers_on_copy,
       round(f.best_offer_usd / f.ask_usd * 100, 1)              AS offer_pct_of_ask,
       round(f.ask_usd - f.best_offer_usd, 2)                    AS spread_usd,
       f.captured_at                                             AS seen_at,
       fmv.fmv_usd,
       now()                                                     AS computed_at
  FROM f
  JOIN public.panini_editions pe ON pe.external_id = f.external_id
  LEFT JOIN public.panini_products pp ON pp.set_id = pe.product_set_id
  LEFT JOIN public.panini_card_serials sr ON sr.sku = f.sku
  LEFT JOIN public.editions e ON e.external_id = f.external_id AND e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
  LEFT JOIN public.edition_fmv_current fmv ON fmv.edition_id = e.id
 WHERE f.best_offer_usd > 0
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_panini_offer_spread_pk ON public.mv_panini_offer_spread (external_id);
CREATE INDEX IF NOT EXISTS mv_panini_offer_spread_rank ON public.mv_panini_offer_spread (offer_pct_of_ask DESC, external_id) WHERE ask_usd >= 5;

REVOKE ALL ON public.mv_panini_offer_spread FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_offer_spread TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_offer_spread IS
  'Panini Bid vs Floor (Top Shot offer-spread parity, audit_20261025): per edition, the CHEAPEST LISTED COPY (ask re-read in 7 days) and the best offer Panini shows on THAT copy — a spread on one card. Panini offers are made on a specific serial, so an edition-wide best offer (often on a #1 or a low serial) is not a bid on a floor copy; measured 10-25: 4,575 of 19,032 floors carry an offer, none above its ask, median offer 22 % of the ask. Refreshed hourly at :38 by refresh_panini_offer_spread().';

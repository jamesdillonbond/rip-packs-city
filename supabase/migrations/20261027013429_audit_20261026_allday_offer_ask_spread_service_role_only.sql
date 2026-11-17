-- audit_20261026: allday_offer_ask_spread is service-role only (applied seconds after 20261027013420).
--
-- Every reader (the /insights/offer-spread page and /api/public/insights/offer-spread) uses the service role, and a
-- security_invoker view granted to anon would depend on anon's rights over every base table (allday_open_offers,
-- editions, cached_listings_v2 via allday_edition_floor_ask). Narrowed rather than widened.
--
-- Revert: GRANT SELECT ON public.allday_offer_ask_spread TO anon, authenticated;

REVOKE ALL ON public.allday_offer_ask_spread FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_offer_ask_spread TO service_role;

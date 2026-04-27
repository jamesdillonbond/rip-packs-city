-- Lock search_path on the 10 read-only analytics RPCs that back /analytics
-- pages. Non-destructive — ALTER FUNCTION ... SET search_path adds a
-- function-scoped GUC without rewriting the body or changing grants.
-- Eliminates the function_search_path_mutable WARN advisor for these 10.
-- Remaining ~80 search_path-mutable functions stay untouched until their
-- owning work streams stabilise (rebuild_flowty_loans which just landed
-- 2026-04-27 01:37 UTC, and the pinnacle_* family in active development).

ALTER FUNCTION public.get_top_sales(uuid, timestamp with time zone, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_tier_analytics(uuid, timestamp with time zone)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_top_editions(uuid, timestamp with time zone, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_daily_tier_volume(uuid, timestamp with time zone)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_period_comparison(uuid, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_market_pulse(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_badge_premium(uuid, timestamp with time zone)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_series_analytics(uuid, timestamp with time zone)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.search_player_analytics(uuid, text, timestamp with time zone, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_daily_series_volume(uuid, timestamp with time zone)
  SET search_path = public, pg_temp;

-- audit_20261030_flowty_listing_lanes_retired_backup_and_watchlist
-- anon-exec: none (tables only; no function created)
--
-- Flowty retirement runbook §3 steps 3-4 (2026-10-30). The Flowty API has been dark since 10-27 ~9:20 PM PT,
-- and stayed dark more than 24 h after All Day traded again (first sale 10-28 11:12 PM PT), which was Trevor's
-- gate (runbook §0, HELD 10-28 ~7:45 AM PT). Backs up the Flowty rows, then retires the three lanes on the
-- cadence watchlist. The row deletes ran separately (execute_sql, 2026-10-30 ~10:20 AM PT), each keyed to
-- the backup: `cached_listings` source='flowty' 319 rows (Top Shot 111, All Day 108, Golazos 100) and
-- `cached_listings_v2` source='flowty' open rows 8 (All Day, newest 2026-05-23).
--
-- REVERT:
--   INSERT INTO public.cached_listings SELECT * FROM public.audit_20261030_flowty_cached_listings_backup;
--   INSERT INTO public.cached_listings_v2 SELECT * FROM public.audit_20261030_flowty_cached_listings_v2_open_backup;
--   UPDATE public.pipeline_cadence_watchlist SET is_active = true
--    WHERE pipeline IN ('topshot-listing-cache','allday-listing-cache','golazos-listing-cache');
CREATE TABLE IF NOT EXISTS public.audit_20261030_flowty_cached_listings_backup AS
  SELECT * FROM public.cached_listings WHERE source = 'flowty';
CREATE TABLE IF NOT EXISTS public.audit_20261030_flowty_cached_listings_v2_open_backup AS
  SELECT * FROM public.cached_listings_v2 WHERE source = 'flowty' AND completed_at IS NULL;
ALTER TABLE public.audit_20261030_flowty_cached_listings_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20261030_flowty_cached_listings_v2_open_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261030_flowty_cached_listings_backup FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.audit_20261030_flowty_cached_listings_v2_open_backup FROM PUBLIC, anon, authenticated;

UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = coalesce(notes, '') || ' [RETIRED 2026-10-30: Flowty API dark since 10-27; lane deleted]'
 WHERE pipeline IN ('topshot-listing-cache', 'allday-listing-cache', 'golazos-listing-cache')
   AND is_active;

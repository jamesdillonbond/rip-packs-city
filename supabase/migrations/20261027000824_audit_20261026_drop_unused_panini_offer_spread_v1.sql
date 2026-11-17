-- audit_20261026: remove the retired v1 Panini offer-spread materialized view.
-- 20261026051156 renamed it to mv_panini_offer_spread_v1_unused when the floor-copy version replaced it.
-- Checked 10-26 before removal: no view, function or pg_cron job reads it, and no code reads it.
-- Its two indexes go with it. 112 kB.
-- Revert: re-apply the view definition from 20261026051029 under this name (nothing reads it, so not needed).
DROP MATERIALIZED VIEW IF EXISTS public.mv_panini_offer_spread_v1_unused;

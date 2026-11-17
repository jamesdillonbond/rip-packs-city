-- Batch 6 of search_path hardening — write-side functions.
-- Final write-side batch. Each function body was inspected before applying:
-- all references resolve to public-schema tables/types (qualified or
-- unqualified — both work under search_path = public, pg_temp), and only
-- pg_catalog built-ins are used. No body rewrites required; ALTER FUNCTION
-- alone is safe.
--
-- Smoke-tested post-apply with no-op inputs:
--   * aggregate_saved_wallet_stats(uuid, text)   → 0 rows updated
--   * refresh_seeded_wallet_stats(text)          → returns void cleanly
--   * upsert_allday_marketplace_fmv('[]'::jsonb) → (0, 0, 0)
--
-- Brings hardened-function count from 100 → 110 of 140 (71.4%). Remaining
-- 30 are intentionally deferred: 24 pinnacle_*, 4 pack_ev/rebuild_flowty_loans,
-- 2 flowty_* — revisit when those work streams stabilize.
--
-- Note: compute_price_snapshots() (no-arg, default-bucket) was already
-- hardened in an earlier migration; this migration covers only the
-- (interval) overload.

ALTER FUNCTION public.aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.save_user_wallet(p_owner_key text, p_wallet_address text, p_topshot_username text, p_display_name text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.sync_cached_fmv()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.upsert_wallet_moments(p_wallet_address text, p_collection_id uuid, p_moments jsonb)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.refresh_seeded_wallet_stats(p_wallet_address text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.upsert_allday_marketplace_fmv(p_rows jsonb)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.batch_refresh_all_seeded_stats()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.compute_price_snapshots(bucket_interval interval)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.backfill_cost_basis_from_ids(p_wallet text, p_nft_ids text[], p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.seed_topshot_editions(p_external_ids text[])
  SET search_path = public, pg_temp;

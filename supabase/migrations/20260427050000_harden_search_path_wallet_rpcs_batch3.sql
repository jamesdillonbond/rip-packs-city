-- Batch 3 of search_path hardening — read-only wallet-display RPCs.
-- Same pattern as batches 1 & 2: ALTER FUNCTION ... SET search_path adds a
-- function-scoped GUC without changing function bodies, return types, or
-- grants. Targets the wallet-display RPCs that back the profile, watchlist,
-- and collection views. None are in active development; none overlap with
-- pinnacle_*, compute-pack-ev, or rebuild_flowty_loans work streams.
--
-- get_wallet_moments_with_fmv and get_wallet_total_fmv already carry
-- statement_timeout=30s in proconfig; adding search_path appends a second
-- GUC and does not displace the timeout setting.

ALTER FUNCTION public.get_acquisition_stats(p_wallet text, p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_acquisition_summary(p_wallet text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_collections(p_wallet text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_cost_basis(p_wallet text, p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_edition_keys(p_wallet text, p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_fmv_history(p_wallet text, p_days integer, p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_moments_with_fmv(p_wallet text, p_sort_by text, p_limit integer, p_offset integer, p_player text, p_series integer, p_tier text, p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_summary(p_wallet text, p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_tier_counts(p_wallet text, p_collection_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_wallet_total_fmv(p_wallet text, p_collection_id uuid)
  SET search_path = public, pg_temp;

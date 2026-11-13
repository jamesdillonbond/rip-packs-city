-- audit_20261112_candy_retire_noncard_wmc
--
-- 2026-11-12 ~7:45 PM PT (Claude Code cloud; Trevor: "Work through and get those figured out").
-- Overdrive Rewards: every census walk receives 24 assets without metadata, hydrates all 24, and classifies
-- them as NON-cards (Item Type=Pack — "Overdrive Reward Pack 10"); cards 0. Yet wallet_moments_cache holds 24
-- rows for exactly those mints on a label-less `…:overdrive-reward-pack-10` edition, written 11-08 by the old
-- unhydrated path (it keyed the bare name as a card). The census never removes a row for an asset it SAW and
-- classified as a pack or burnt, so they stay forever. This deletes Candy holdings rows BY MOMENT ID for assets
-- the walk positively identified as non-cards — per-asset evidence, so no share cap; a scoped opt-in past
-- rpc_delete_guard for this transaction only (the purge_candy_wmc_ghost_rows_for pattern).
--
-- PIN: supabase/tests/candy_retire_noncard_wmc.sql
-- REVERT: DROP FUNCTION public.candy_retire_noncard_wmc(text[]); and revert the commit titled
--   "candy census: retire rows for assets the walk saw as packs or burnt; UFC tier absent at source".

CREATE OR REPLACE FUNCTION public.candy_retire_noncard_wmc(p_moment_ids text[])
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_moment_ids IS NULL OR cardinality(p_moment_ids) = 0 THEN
    RETURN 0;
  END IF;
  -- Scoped opt-in past rpc_delete_guard, this transaction only.
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);
  WITH del AS (
    DELETE FROM public.wallet_moments_cache
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND moment_id = ANY (p_moment_ids)
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  PERFORM set_config('rpc.allow_bulk_delete', 'off', true);
  RETURN v_deleted;
END
$fn$;

REVOKE ALL ON FUNCTION public.candy_retire_noncard_wmc(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_retire_noncard_wmc(text[]) TO service_role;

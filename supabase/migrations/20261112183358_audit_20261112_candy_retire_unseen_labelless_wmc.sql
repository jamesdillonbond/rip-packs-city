-- audit_20261112_candy_retire_unseen_labelless_wmc
--
-- 2026-11-12 ~10:35 AM PT (Claude Code cloud; Trevor: "How's this looking?" after "Keep going and try to fix all
-- of these"). The census RETIRE step (af8a129ad) deleted wallet_moments_cache rows straight through PostgREST;
-- rpc_delete_guard (max_wallet_span 3) correctly blocked it on the 9:57 AM PT run — 4 collections, 6–43 rows
-- each across up to 38 wallets — and failed the run. A sanctioned bulk delete on this table goes through a
-- scoped function that opts in for its own transaction only (the purge_candy_wmc_ghost_rows_for pattern).
--
-- candy_retire_unseen_labelless_wmc(p_edition_keys, p_max_rows) deletes Candy holdings rows on the given
-- edition keys, re-checking SERVER-SIDE that each key is a Candy edition that STILL has no thumbnail (a key
-- filled or re-keyed since the caller read it is dropped, never deleted under), and refuses — deleting nothing —
-- when the rows exceed p_max_rows. The caller decides WHICH keys (no card of a clean complete walk resolved to
-- them); this function only guarantees the delete cannot reach a labelled edition or exceed the cap.
--
-- PIN: supabase/tests/candy_retire_unseen_labelless_wmc.sql
-- REVERT: DROP FUNCTION public.candy_retire_unseen_labelless_wmc(text[], integer); and revert the commit titled
--   "candy census: retire via a guarded function" (the census then fails the retire step, as at 9:57 AM PT).

CREATE OR REPLACE FUNCTION public.candy_retire_unseen_labelless_wmc(p_edition_keys text[], p_max_rows integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_keys text[];
  v_rows integer;
  v_wallets integer;
  v_deleted integer := 0;
BEGIN
  IF p_edition_keys IS NULL OR cardinality(p_edition_keys) = 0 THEN
    RETURN jsonb_build_object('retired', 0, 'rows', 0, 'refused', false, 'keys', 0);
  END IF;
  SELECT array_agg(e.external_id) INTO v_keys
    FROM public.editions e
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
     AND e.external_id = ANY (p_edition_keys)
     AND e.thumbnail_url IS NULL;
  IF v_keys IS NULL THEN
    RETURN jsonb_build_object('retired', 0, 'rows', 0, 'refused', false, 'keys', 0);
  END IF;
  SELECT count(*), count(DISTINCT wallet_address) INTO v_rows, v_wallets
    FROM public.wallet_moments_cache
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
     AND edition_key = ANY (v_keys);
  IF p_max_rows IS NULL OR v_rows > p_max_rows THEN
    RETURN jsonb_build_object('retired', 0, 'rows', v_rows, 'wallets', v_wallets, 'refused', true, 'keys', cardinality(v_keys));
  END IF;
  -- Scoped opt-in past rpc_delete_guard, this transaction only (set_config is_local = true).
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);
  WITH del AS (
    DELETE FROM public.wallet_moments_cache
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND edition_key = ANY (v_keys)
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  PERFORM set_config('rpc.allow_bulk_delete', 'off', true);
  RETURN jsonb_build_object('retired', v_deleted, 'rows', v_rows, 'wallets', v_wallets, 'refused', false, 'keys', cardinality(v_keys));
END
$fn$;

REVOKE ALL ON FUNCTION public.candy_retire_unseen_labelless_wmc(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_retire_unseen_labelless_wmc(text[], integer) TO service_role;

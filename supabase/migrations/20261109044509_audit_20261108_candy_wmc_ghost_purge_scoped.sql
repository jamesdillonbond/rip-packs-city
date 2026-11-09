-- audit_20261108_candy_wmc_ghost_purge_scoped
--
-- purge_candy_wmc_ghost_rows() window-ranks EVERY Candy wmc row (~1.4M since the 11-08
-- collections census) to find moments held under two wallets. The census run of 7:57 PM PT
-- failed on it ("ghost purge: canceling statement due to statement timeout", 120 s), and the
-- Candy wallet refresh calls it on every pasted address. A ghost can only appear where a
-- NEW row was inserted for a moment that already had one, so a caller that knows which
-- moments it inserted needs to rank only those: this scoped form takes them (served by
-- idx_wmc_moment_collection_cover) and deletes the same rows the full form would for those
-- moments — every row but the newest per moment_id. The full form stays for the daily
-- registry census.
--
-- when-others-timeout-blind: n/a — no exception handler.
-- anon-exec: intentional — revoked from PUBLIC/anon/authenticated below; service_role only (purge_candy_wmc_ghost_rows_for)
--
-- Rollback: DROP FUNCTION public.purge_candy_wmc_ghost_rows_for(text[]);

CREATE OR REPLACE FUNCTION public.purge_candy_wmc_ghost_rows_for(p_moment_ids text[])
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_moment_ids IS NULL OR cardinality(p_moment_ids) = 0 THEN
    RETURN 0;
  END IF;
  -- Same scoped opt-in as purge_candy_wmc_ghost_rows: only rows superseded by a newer row
  -- for the SAME moment_id are deleted.
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY moment_id ORDER BY last_seen_at DESC) AS rn
      FROM public.wallet_moments_cache
     WHERE moment_id = ANY (p_moment_ids)
       AND collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  ), del AS (
    DELETE FROM public.wallet_moments_cache w
     USING ranked r
     WHERE w.id = r.id AND r.rn > 1
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_candy_wmc_ghost_rows_for(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_candy_wmc_ghost_rows_for(text[]) TO service_role;

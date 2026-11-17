-- audit_20260830: backfill_wmc_metadata_from_editions rewrote every row it could
-- NOT fill, on every wallet-backfill child run, and the phantom count defeated
-- the stats-refresh gate.
--
-- WHAT WAS WRONG
-- The row predicate was "has an edition AND at least one of the five denorm
-- columns is NULL". The SET list is all COALESCE(wmc.col, e.col), so when the
-- edition's own value is also NULL the row is rewritten with IDENTICAL values:
-- a dead tuple, WAL, index maintenance on a 2.5M-row table whose indexes were
-- at 22–49 % leaf density this morning — and RETURNING 1 counts it as "updated".
-- Measured 2026-08-30 (1 % TABLESAMPLE, ×100): Disney Pinnacle **55,300 of
-- 55,700 rows match the predicate and 0 would change** (team_name is NULL on
-- every Pinnacle edition, permanently); LaLiga Golazos 5,200 match / 600 would
-- change. One ordinary wallet (0xa1123c90c3003508): 71 rows "updated" per run,
-- 0 changed. The function ran 123 times / 2,695 s (22 s mean) in the
-- 13:57–14:13Z window as every non-Top-Shot wallet-backfill child's post-pass.
--
-- THE SECOND-ORDER COST is worse than the rewrite: the caller passes
-- `totalUpserted + postPassUpdated` into stampLastRefreshed(), whose
-- changedRows === 0 gate is the only thing standing between a no-op child run
-- and refresh_seeded_wallet_stats() — the cross-collection aggregate measured
-- at 10.5 s mean / 9.6 M disk reads lifetime (5,932 calls). A phantom 71 means
-- that gate never closes for any wallet holding a Pinnacle or Golazos row.
--
-- FIX: require that at least one column would actually change. Same end state
-- for every row (COALESCE semantics untouched), same signature, same return
-- meaning — the count now equals rows genuinely modified. The pinned test gains
-- a row whose NULLs cannot be filled and asserts it is neither rewritten nor
-- counted. Pinned: supabase/tests/backfill_wmc_metadata_from_editions.sql +
-- __tests__/db-invariants-drift-guard.test.ts (re-pointed to this file).
--
-- anon-exec: backfill_wmc_metadata_from_editions — unchanged (no GRANT/REVOKE
-- here; the 20260713050000 grants stand: EXECUTE for service_role, none for anon).
--
-- Revert: re-apply the function body from 20260713050000_audit_20260713_wmc_team_name_denorm.sql.

CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(
  p_wallet_address text DEFAULT NULL::text,
  p_collection_id  uuid DEFAULT NULL::uuid
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET tier        = COALESCE(wmc.tier,        e.tier::text),
           player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(wmc.set_name,    e.set_name),
           mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
           team_name   = COALESCE(wmc.team_name,   e.team_name)
      FROM public.editions e
     WHERE e.collection_id = wmc.collection_id
       AND e.external_id   = wmc.edition_key
       AND wmc.edition_key IS NOT NULL
       -- Only rows where at least one NULL can actually be filled. Without the
       -- right-hand IS NOT NULL checks a row whose edition is also NULL in that
       -- column was rewritten with identical values on every run (2026-08-30).
       AND (
         (wmc.tier        IS NULL AND e.tier IS NOT NULL) OR
         (wmc.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL) OR
         (wmc.set_name    IS NULL AND e.set_name IS NOT NULL) OR
         (wmc.mint_count  IS NULL AND e.circulation_count IS NOT NULL) OR
         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL)
       )
       AND (p_wallet_address IS NULL OR wmc.wallet_address = p_wallet_address)
       AND (p_collection_id  IS NULL OR wmc.collection_id  = p_collection_id)
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;

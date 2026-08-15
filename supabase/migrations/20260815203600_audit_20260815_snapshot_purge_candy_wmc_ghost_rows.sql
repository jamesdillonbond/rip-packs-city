-- audit_20260815_snapshot_purge_candy_wmc_ghost_rows
--
-- SNAPSHOT MIGRATION — not a change. Captures the CURRENT live definition
-- verbatim (pg_get_functiondef, 2026-08-15) so the function becomes PINNABLE by
-- supabase/tests/purge_candy_wmc_ghost_rows.sql + the drift guard. Applying it
-- is a byte-identical no-op.
--
-- WHY THIS FUNCTION. pg_cron `10 9 * * *` (jobid 201), and it is the daily
-- self-heal for the Candy DAS group-walk, which never deletes the PRIOR owner's
-- row on transfer. It was one of 25 scheduled SECDEF writers with no pin.
--
-- Two invariants, and both are the kind that fail silently:
--
--  1. It deletes ONLY rows superseded by a newer row for the SAME moment_id
--     (row_number() OVER (PARTITION BY moment_id ORDER BY last_seen_at DESC),
--     rn > 1). The surviving row must be the NEWEST. Flip that ORDER BY and the
--     function keeps the ghost and deletes the live owner — wallet_moments_cache
--     is the portfolio store, so that shows a collector someone else's Moments
--     with no error anywhere.
--
--  2. It is SCOPED to the Candy collection uuid. wallet_moments_cache holds all
--     six collections; an unscoped version would dedupe by moment_id across
--     collections, and it holds a deliberate opt-in past the destructive-op
--     circuit breaker (`SET LOCAL rpc.allow_bulk_delete = 'on'`), so nothing
--     downstream would stop it.
--
-- The opt-in is exactly why this needs a pin: rpc_guard_block_destructive is the
-- backstop for a bulk wmc delete, and this function is authorised to walk past
-- it. A pin is the only remaining check on what it deletes.

CREATE OR REPLACE FUNCTION public.purge_candy_wmc_ghost_rows()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_deleted integer := 0;
BEGIN
  -- Deliberate, scoped opt-in past rpc_guard_block_destructive: this function only ever
  -- deletes rows that are provably superseded by a newer row for the SAME moment_id.
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY moment_id ORDER BY last_seen_at DESC) AS rn
    FROM public.wallet_moments_cache
    WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  ), del AS (
    DELETE FROM public.wallet_moments_cache w
    USING ranked r
    WHERE w.id = r.id AND r.rn > 1
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RETURN v_deleted;
END;
$function$;

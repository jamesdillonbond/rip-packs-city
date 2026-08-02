-- audit_20260802_refresh_players_current_team_recurring
--
-- Applied to prod 2026-08-02 via Supabase MCP; this file is the repo record.
-- Includes the pg_cron schedule (jobid 249).
--
-- WHY: `players.team` is a BAKED SNAPSHOT of a derivation over `editions`, and
-- until now nothing ever re-ran that derivation. Two one-off migrations baked it
-- (audit_20260802_players_team_from_recent_edition, 148 rows; then
-- audit_20260802_players_dedupe_pass2_and_team_reheal). Both are point-in-time:
-- every NEW edition that lands with a newer in-horizon game_date can invalidate
-- the stored value, and the stored value is exactly what get_player_detail
-- returns to the public player page.
--
-- Caught in the act: within ~15 minutes of the second repair,
-- `Kentavious Caldwell-Pope` was already wrong again -- stored 'Denver Nuggets'
-- against a derived 'Memphis Grizzlies' from an edition dated 2026-02-01. His
-- players row had NOT been written since 17:45Z, so this was NOT the ingest
-- clobber (separately fixed by upsert_player_canonical) -- the DERIVATION moved
-- underneath the snapshot. Traded players would otherwise drift back to a stale
-- team continuously as new editions arrive, and the only thing that ever fixed
-- it was a human noticing.
--
-- FIX: the same derivation as a callable SECDEF function plus a daily pg_cron
-- job, so the snapshot self-heals instead of decaying between manual repairs.
--
-- Semantics are byte-identical to the two repair migrations, deliberately:
--   * team = team_name of the player's most recent edition INSIDE the
--     data-relative 18-month horizon (collection max(game_date) - 18 months);
--   * players with NO in-horizon edition are UNTOUCHED, preserving the
--     retired-player behaviour the 08-01 fix established (Paul Pierce keeps
--     Boston Celtics rather than his final Nets stint);
--   * joined on player_name, matching the repair migrations.
--
-- Scoped to Top Shot only, matching the precedent set by both repair migrations.
-- Widening it to other collections is a deliberate future call, not a default.
--
-- COST: measured 38 ms, 5,461 buffers (all cache hits, 1 disk read) on the live
-- instance -- negligible for a daily job even under the current IOPS pressure.
-- Scheduled 09:40 UTC, off the :00/:11/:23/:47 cron cluster.
--
-- VERIFIED after applying: first invocation returned 1 (Caldwell-Pope), and a
-- follow-up read in a SEPARATE statement confirmed Caldwell-Pope -> Memphis
-- Grizzlies, Jrue Holiday -> Portland Trail Blazers, Paul Pierce -> Boston
-- Celtics and John Havlicek -> Boston Celtics (both retired, untouched), with
-- teams-wrong-in-horizon = 0 and duplicate slugs = 0.
-- ⚠ Note for future verifiers: calling the function and re-reading the count in
-- the SAME statement returns the PRE-update snapshot and looks like a no-op.
-- Verify in a separate statement.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-refresh-players-current-team');
--   DROP FUNCTION IF EXISTS public.refresh_players_current_team(uuid);

CREATE OR REPLACE FUNCTION public.refresh_players_current_team(
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated int;
BEGIN
  IF p_collection_id IS NULL THEN
    RETURN 0;
  END IF;

  WITH h AS (
    SELECT max(game_date) AS mg FROM public.editions
     WHERE collection_id = p_collection_id AND game_date IS NOT NULL
  ), r AS (
    SELECT DISTINCT ON (e.player_name) e.player_name, e.team_name
      FROM public.editions e, h
     WHERE e.collection_id = p_collection_id
       AND e.team_name IS NOT NULL
       AND e.game_date IS NOT NULL
       AND e.game_date >= h.mg - interval '18 months'
     ORDER BY e.player_name, e.game_date DESC
  ), upd AS (
    UPDATE public.players p
       SET team = r.team_name, updated_at = now()
      FROM r
     WHERE p.collection_id = p_collection_id
       AND p.name = r.player_name
       AND p.team IS DISTINCT FROM r.team_name
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  RETURN v_updated;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_players_current_team(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_players_current_team(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_players_current_team(uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.refresh_players_current_team(uuid) TO cron_heavy;

-- pg_cron jobid 249 (applied separately via execute_sql; recorded here):
--   SELECT cron.schedule('rpc-refresh-players-current-team', '40 9 * * *',
--     $$SELECT public.refresh_players_current_team();$$);

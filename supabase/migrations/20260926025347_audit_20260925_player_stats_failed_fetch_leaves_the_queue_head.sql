-- 2026-09-25 (PT) — player-stats-sync: a player whose ESPN stats fetch FAILS
-- leaves the front of the queue too.
--
-- WHY. player_stats_sync_targets orders by stats_refreshed_at NULLS FIRST, and
-- only upsert_player_season_stats stamps that column — for a player ESPN
-- answered (200 or 404). A player whose stats endpoint answers 500 every time
-- is never stamped, so he is re-read at the HEAD of every run forever. Measured
-- 2026-09-25: five NBA identities (Nate Robinson, Mario Chalmers, Derrick
-- Favors, Kent Bazemore, Doc Rivers) had never been stamped and 500'd on every
-- run since 18:46 PT; the run-level failure count sat at 8-9 of 300 against a
-- 5 % (15) threshold, and every resolve batch can add more such players — past
-- 15 every NBA run reads failed, permanently.
--
-- WHAT.
-- (1) player_identities.stats_failed_at — when a stats fetch last FAILED
--     (HTTP != 200/404, network, parse). Never read by the player page, which
--     keeps reading stats_refreshed_at (so "refreshed" still means refreshed).
-- (2) player_stats_sync_targets orders by the later of the two stamps, NULLS
--     FIRST: a failed player goes to the back like a refreshed one and is
--     retried once per cycle (~1,300 NBA targets / 300 per run), not every run.
--     Same signature, same body otherwise.
-- (3) mark_player_stats_fetch_failed(p_league, p_espn_ids) — stamps (1);
--     returns rows stamped. Service role only, like its siblings.
--
-- Revert: restore player_stats_sync_targets' ORDER BY to
--   `i.stats_refreshed_at NULLS FIRST, i.refreshed_at, i.id` (20260925233446);
--   DROP FUNCTION public.mark_player_stats_fetch_failed(text, text[]);
--   ALTER TABLE public.player_identities DROP COLUMN stats_failed_at;

ALTER TABLE public.player_identities
  ADD COLUMN IF NOT EXISTS stats_failed_at timestamptz;

COMMENT ON COLUMN public.player_identities.stats_failed_at IS
  'When the player-stats-sync runner last FAILED to fetch this identity''s ESPN stats (HTTP other than 200/404, network, parse). Queue position only — stats_refreshed_at is the freshness of the stats.';

CREATE OR REPLACE FUNCTION public.player_stats_sync_targets(p_league text, p_limit integer DEFAULT 300)
 RETURNS TABLE(identity_id uuid, espn_id text, espn_league text, display_name text, stats_refreshed_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT i.id AS identity_id, i.espn_id, COALESCE(i.espn_league, i.league) AS espn_league, i.display_name, i.stats_refreshed_at
    FROM public.player_identities i
   WHERE i.league = p_league
     AND i.player_id IS NOT NULL
     AND i.espn_id IS NOT NULL
   -- GREATEST ignores NULLs: a never-tried player is NULL (first); a failed one
   -- sorts by its failure, a refreshed one by its refresh (20260926 stats_failed_at)
   ORDER BY GREATEST(i.stats_refreshed_at, i.stats_failed_at) NULLS FIRST, i.refreshed_at, i.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 300), 2000))
$function$;

-- Restated, unchanged from 20260925233446 (live ACL is already service_role only).
REVOKE ALL ON FUNCTION public.player_stats_sync_targets(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_stats_sync_targets(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_player_stats_fetch_failed(p_league text, p_espn_ids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  IF p_espn_ids IS NULL OR array_length(p_espn_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.player_identities i
     SET stats_failed_at = now()
   WHERE i.league = p_league AND i.espn_id = ANY (p_espn_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;

REVOKE ALL ON FUNCTION public.mark_player_stats_fetch_failed(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_player_stats_fetch_failed(text, text[]) TO service_role;

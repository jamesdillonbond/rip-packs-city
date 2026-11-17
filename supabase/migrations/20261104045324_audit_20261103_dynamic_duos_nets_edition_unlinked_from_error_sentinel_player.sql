-- audit_20261103_dynamic_duos_nets_edition_unlinked_from_error_sentinel_player
--
-- 2026-11-03, from the clock: 8:48–8:54 PM PT, applied 8:53 PM PT (Claude Code cloud; Trevor: "Keep going, proceed with all
-- that make sense"; found by a sweep for invented 'Unknown…' values).
--
-- WHAT WAS WRONG. `players` held a Top Shot row named "Unknown (error loading)" (id 49325c43…, created
-- 2026-09-25, external_id 'nba_top_shot-unknown-error-loading-') — /api/wallet-search's per-row LOAD-FAILURE
-- label persisted as a person. Edition 85:2918 (Dynamic Duos · Brooklyn Nets — Brook Lopez & Deron Williams;
-- 414 sales, 62 held) pointed its player_id at it, with player_name NULL. A failed read rendered as a fact on
-- every surface that follows editions.player_id (player pages, search's player arm counts it as 1 edition).
-- The writer is already fixed (wallet-search strips the sentinel before caching, 09-03, known-issues #18; no
-- DB function or table carries the string); this is the leftover row.
--
-- CHANGE (data, 2 rows). The edition takes its set's own convention — every other Dynamic Duos edition reads
-- player_name = the team name with player_id NULL (it is a team pairing, not one person) — and the sentinel
-- player is deactivated and left with no editions. Not deleted (destructive; nothing references it after this).
--
-- REVERT:
--   UPDATE public.editions e SET player_name = b.player_name, player_id = b.player_id
--     FROM public.audit_20261103_error_sentinel_player_backup b WHERE b.kind = 'edition' AND e.id = b.row_id;
--   UPDATE public.players p SET is_active = b.is_active
--     FROM public.audit_20261103_error_sentinel_player_backup b WHERE b.kind = 'player' AND p.id = b.row_id;

CREATE TABLE IF NOT EXISTS public.audit_20261103_error_sentinel_player_backup AS
  SELECT 'edition'::text AS kind, e.id AS row_id, e.player_name, e.player_id, NULL::boolean AS is_active, now() AS backed_up_at
  FROM public.editions e WHERE e.player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3'
  UNION ALL
  SELECT 'player', p.id, p.name, NULL::uuid, p.is_active, now()
  FROM public.players p WHERE p.id = '49325c43-c6ba-41bc-a22f-a3059d528fb3';
ALTER TABLE public.audit_20261103_error_sentinel_player_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261103_error_sentinel_player_backup FROM anon, authenticated;

UPDATE public.editions
SET player_name = team_name, player_id = NULL
WHERE player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3'
  AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND external_id = '85:2918'
  AND player_name IS NULL
  AND set_name = 'Dynamic Duos';

UPDATE public.players SET is_active = false
WHERE id = '49325c43-c6ba-41bc-a22f-a3059d528fb3' AND name = 'Unknown (error loading)';

DO $post$
BEGIN
  IF (SELECT count(*) FROM public.audit_20261103_error_sentinel_player_backup) <> 2 THEN
    RAISE EXCEPTION 'post-flight: backup should hold 2 rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public.editions WHERE player_id = '49325c43-c6ba-41bc-a22f-a3059d528fb3') THEN
    RAISE EXCEPTION 'post-flight: an edition still points at the sentinel player';
  END IF;
  IF (SELECT player_name FROM public.editions WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id = '85:2918') IS DISTINCT FROM 'Brooklyn Nets' THEN
    RAISE EXCEPTION 'post-flight: 85:2918 player_name is not Brooklyn Nets';
  END IF;
END
$post$;

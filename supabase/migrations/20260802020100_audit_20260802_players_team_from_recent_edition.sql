-- audit_20260802_players_team_from_recent_edition
--
-- MUST BE APPLIED WITH audit_20260802_players_dedupe_and_canonical_resolver.
-- Applied to prod 2026-08-02 via Supabase MCP; this file is the repo record.
--
-- WHY: the 2026-08-01 current-team fix (418ed607) was LOAD-BEARING ON THE
-- DUPLICATES. get_player_detail ranks the CANDIDATE players rows for a slug and
-- prefers whichever candidate's `team` equals the team_name on the most recent
-- edition inside a data-relative 18-month horizon:
--
--     ORDER BY (CASE WHEN r.team_name IS NOT NULL
--                     AND r.game_date >= h.max_gd - interval '18 months'
--                     AND c.team = r.team_name
--                    THEN 1 ELSE 0 END) DESC,
--              c.team_edition_count DESC NULLS LAST, ...
--
-- A traded player rendered his CURRENT team only because some duplicate row
-- happened to carry it — Donovan Mitchell's canonical row `1628378` says
-- 'Utah Jazz'; only the `flow:8392` duplicate said 'Cleveland Cavaliers'.
-- Deduplicating removes that candidate, so the tie-break has nothing correct
-- left to pick. Verified live immediately after the dedupe: `mitchell` regressed
-- to "Utah Jazz". This migration is the other half of that change, not an
-- optional follow-up.
--
-- FIX: bake the derivation into the DATA instead of leaving it to a tie-break —
-- which is the whole point of deduplicating. Set each survivor's `team` to the
-- team_name of its most recent in-horizon edition (148 rows). Players with NO
-- in-horizon edition are deliberately UNTOUCHED, preserving the retired-player
-- behaviour the 08-01 fix established (Paul Pierce keeps Boston Celtics rather
-- than his final Nets stint).
--
-- Verified after applying: mitchell -> Cleveland Cavaliers, SGA -> Oklahoma City
-- Thunder, brunson -> New York Knicks, durant -> Houston Rockets, lebron ->
-- Los Angeles Lakers, curry -> Golden State Warriors, pierce -> Boston Celtics.
--
-- REVERT:
--   UPDATE public.players p SET team = b.old_team
--     FROM public.audit_20260802_players_team_backup b WHERE p.id = b.id;

CREATE TABLE public.audit_20260802_players_team_backup AS
WITH h AS (
  SELECT max(game_date) AS mg FROM public.editions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND game_date IS NOT NULL
), r AS (
  SELECT DISTINCT ON (e.player_name) e.player_name, e.team_name
    FROM public.editions e, h
   WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND e.team_name IS NOT NULL AND e.game_date IS NOT NULL
     AND e.game_date >= h.mg - interval '18 months'
   ORDER BY e.player_name, e.game_date DESC
)
SELECT p.id, p.name, p.team AS old_team, r.team_name AS new_team
  FROM public.players p
  JOIN r ON r.player_name = p.name
 WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND p.team IS DISTINCT FROM r.team_name;

ALTER TABLE public.audit_20260802_players_team_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260802_players_team_backup FROM anon, authenticated;

UPDATE public.players p
   SET team = b.new_team, updated_at = now()
  FROM public.audit_20260802_players_team_backup b
 WHERE p.id = b.id;

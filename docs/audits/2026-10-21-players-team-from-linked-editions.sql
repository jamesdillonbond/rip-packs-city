-- 2026-10-21 ~7:05 AM PT (Claude Code cloud; Trevor: "Keep going") — players.team that none of the
-- player's OWN editions carries.
--
-- Found by a live sweep: /nfl-all-day/player/marvin-harrison (Sr., 5 Colts editions) read "Arizona
-- Cardinals" in its header and breadcrumb — Jr.'s team (rule 2: a NAME is not a PERSON). A census of
-- players.team against the teams of the editions linked to that row (editions.player_id):
--   laliga_golazos  54 of 360  — double-encoded UTF-8 ("AtlÃ©tico de Madrid" for "Atlético de Madrid",
--                                "UD AlmerÃ­a", "CÃ¡diz CF", "Deportivo de la CoruÃ±a"), rendered as-is
--                                on player pages
--   nba_top_shot     4 of 1,337 — WNBA abbreviations ("PHO", "MIN", "Aces", "Valkyries")
--   nfl_all_day      1 of 1,467 — Marvin Harrison (Sr.) "Arizona Cardinals" vs "Indianapolis Colts"
-- No scheduled writer causes these: refresh_players_current_team runs for Top Shot only (pg_cron
-- `SELECT public.refresh_players_current_team()`, default arg) and these rows were last written in May.
--
-- FIX (data, UPDATE only): only rows whose team matches NONE of their linked editions' teams get the
-- team of their most recent linked edition (game_date, then created_at). Rows that agree with any
-- linked edition are untouched. Old values are kept in the note below for the revert.
--
-- REVERT: re-run with the before-image this statement returns (player id, old team), e.g.
--   UPDATE public.players SET team = '<old>' WHERE id = '<id>';
-- (the RETURNING output of the run is copied into the ledger entry of this date).

WITH linked AS (
  SELECT p.id, p.team AS old_team,
         array_agg(DISTINCT e.team_name) FILTER (WHERE e.team_name IS NOT NULL) AS teams,
         (array_agg(e.team_name ORDER BY e.game_date DESC NULLS LAST, e.created_at DESC)
            FILTER (WHERE e.team_name IS NOT NULL))[1] AS latest_team
    FROM public.players p
    JOIN public.editions e ON e.player_id = p.id
   WHERE p.team IS NOT NULL
   GROUP BY p.id, p.team
), fix AS (
  UPDATE public.players p
     SET team = l.latest_team, updated_at = now()
    FROM linked l
   WHERE p.id = l.id
     AND l.teams IS NOT NULL
     AND NOT (l.old_team = ANY (l.teams))
     AND l.latest_team IS NOT NULL
  RETURNING p.id, p.collection_id, l.old_team, p.team AS new_team
)
SELECT c.slug, count(*) AS rows_fixed,
       jsonb_agg(jsonb_build_object('id', f.id, 'old', f.old_team, 'new', f.new_team)) AS before_after
  FROM fix f JOIN public.collections c ON c.id = f.collection_id
 GROUP BY c.slug;

-- ── RAN 2026-10-21 ~7:10 AM PT: 59 rows (laliga_golazos 54, nba_top_shot 4, nfl_all_day 1). ──
-- Golazos: every old value was the double-encoded spelling of a linked edition's club (revert = re-mojibake;
-- not worth restoring), except 3545580a… "CD LeganÃ©s" → "RCD Espanyol de Barcelona" (his latest edition).
-- Exact before-image of the non-encoding rows, for a revert:
--   UPDATE public.players SET team = 'Valkyries' WHERE id = 'e71bb284-8396-4ccc-967b-5439e5df88ee';
--   UPDATE public.players SET team = 'MIN' WHERE id = '7c63dc20-78a4-408c-8c16-b8d17cd62428';
--   UPDATE public.players SET team = 'Aces' WHERE id = '627a297f-2d36-4f7c-ba75-5a0163ed0e91';
--   UPDATE public.players SET team = 'PHO' WHERE id = '41ae07f9-3491-4729-aced-43ef469053cb';
--   UPDATE public.players SET team = 'Arizona Cardinals' WHERE id = '88a7476d-7d94-4515-b0e0-ae41482323e6';
--   UPDATE public.players SET team = 'CD Leganés' WHERE id = '3545580a-427d-4f7f-87ae-dd765df0b7d2';  -- (old value, decoded)

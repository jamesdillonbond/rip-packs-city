-- 2026-09-24 (PT) — /analytics "Recent Whale Trades" printed
-- "Unknown (error loading) · #1023 · The Champion's Path" for a $7.1k sale.
-- The wallet-search route's per-moment FAILURE SENTINEL ("Unknown (error
-- loading)") was persisted as a `players` row on 2026-05-09 and 123 Top Shot
-- TEAM moments (every one carries team_name; 50 have player_name NULL, 73
-- carry the team name) were linked to it, so every player-name join on those
-- editions published the sentinel as a name. A team moment has no player —
-- the honest value is player_id NULL (tileSubject then renders "<team> <play>").
-- The route has guarded the sentinel since (wallet-search/route.ts:986), so no
-- writer re-creates it; this is the residue. The sibling "Unknown" player row
-- (0 editions) is dropped too.
--
-- Revert: INSERT the two players rows back from the backup table and
-- UPDATE editions SET player_id = '05b29206-2a04-44ed-afca-8ef92e2be260'
-- WHERE id IN (SELECT edition_id FROM audit_20260924_unknown_player_editions_backup).
CREATE TABLE IF NOT EXISTS public.audit_20260924_unknown_player_editions_backup AS
  SELECT e.id AS edition_id, e.player_id, now() AS backed_up_at
  FROM public.editions e
  WHERE e.player_id IN ('05b29206-2a04-44ed-afca-8ef92e2be260', 'b38d3a61-b4d7-4f3c-97e8-a1dea6e451ef');
ALTER TABLE public.audit_20260924_unknown_player_editions_backup ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.audit_20260924_unknown_players_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p
  WHERE p.id IN ('05b29206-2a04-44ed-afca-8ef92e2be260', 'b38d3a61-b4d7-4f3c-97e8-a1dea6e451ef');
ALTER TABLE public.audit_20260924_unknown_players_backup ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE v_backup int; v_target int; v_updated int; v_deleted int;
BEGIN
  SELECT count(*) INTO v_backup FROM public.audit_20260924_unknown_player_editions_backup;
  SELECT count(*) INTO v_target FROM public.editions
   WHERE player_id IN ('05b29206-2a04-44ed-afca-8ef92e2be260', 'b38d3a61-b4d7-4f3c-97e8-a1dea6e451ef');
  IF v_backup <> v_target THEN
    RAISE EXCEPTION 'backup (%) does not cover the target set (%)', v_backup, v_target;
  END IF;
  -- Every linked edition must be a team moment (team_name present) or have no
  -- player name at all — never a real player's edition.
  IF EXISTS (SELECT 1 FROM public.editions e
              WHERE e.player_id = '05b29206-2a04-44ed-afca-8ef92e2be260'
                AND e.team_name IS NULL AND e.player_name IS NOT NULL) THEN
    RAISE EXCEPTION 'an edition linked to the sentinel player has a player name and no team — refusing';
  END IF;
  UPDATE public.editions SET player_id = NULL, updated_at = now()
   WHERE player_id IN ('05b29206-2a04-44ed-afca-8ef92e2be260', 'b38d3a61-b4d7-4f3c-97e8-a1dea6e451ef');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  -- Team-named player_name on a team moment is the team, not a player: clear it
  -- so tileSubject renders "<team> <play>" (its documented team-moment shape).
  UPDATE public.editions SET player_name = NULL, updated_at = now()
   WHERE id IN (SELECT edition_id FROM public.audit_20260924_unknown_player_editions_backup)
     AND player_name IS NOT NULL AND player_name = team_name;
  DELETE FROM public.players WHERE name IN ('Unknown (error loading)', 'Unknown')
    AND id IN ('05b29206-2a04-44ed-afca-8ef92e2be260', 'b38d3a61-b4d7-4f3c-97e8-a1dea6e451ef');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'unlinked % editions, deleted % sentinel players', v_updated, v_deleted;
  IF v_updated <> v_target OR v_deleted <> 2 THEN
    RAISE EXCEPTION 'post-condition failed: updated % of %, deleted %', v_updated, v_target, v_deleted;
  END IF;
  IF EXISTS (SELECT 1 FROM public.players WHERE name ILIKE 'unknown%') THEN
    RAISE EXCEPTION 'a sentinel player row survived';
  END IF;
END $$;

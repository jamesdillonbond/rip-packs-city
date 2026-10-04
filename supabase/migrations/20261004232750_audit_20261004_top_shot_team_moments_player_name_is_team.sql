-- audit_20261004_top_shot_team_moments_player_name_is_team
--
-- 2026-10-04 ~4:35 PM PT (Claude Code cloud; Trevor: "Keep going with that").
--
-- WHAT (register R8, second half). Top Shot's convention for a TEAM Moment is player_name = team_name
-- (__tests__/moment-subject-href-team-moments.test.ts): 358 of the 590 team Moments follow it and 226
-- carry player_name NULL, so the same kind of Moment answers "who" two ways. Readers that fall back
-- on the name (get_wallet_moments_with_fmv) and the team-page link (momentSubjectHref, keyed on
-- player_name = team_name) see the NULL half differently.
--
-- CHANGE. player_name := trim(team_name) on those 226 rows (player_id NULL, team_name set). The
-- hydrator now writes the same for a new team Moment (lib/editions-hydrate.ts, same commit).
-- SAFE BY GUARD, checked 2026-10-04: ensure_players_from_edition_names skips player_name = team_name
-- (no player minted); link_editions_to_players_by_name matches players.name, and 0 Top Shot players
-- rows are named after a team; normalize_player_name_alias only rewrites on an alias slug hit (none
-- for a team name).
--
-- Backup (RLS on, revoked): audit_20261004_team_moment_player_name_backup (edition_id, old_player_name).
-- REVERT: UPDATE public.editions e SET player_name = b.old_player_name
--           FROM public.audit_20261004_team_moment_player_name_backup b WHERE e.id = b.edition_id;

CREATE TABLE IF NOT EXISTS public.audit_20261004_team_moment_player_name_backup (
  edition_id uuid PRIMARY KEY, old_player_name text, backed_up_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.audit_20261004_team_moment_player_name_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_team_moment_player_name_backup FROM PUBLIC, anon, authenticated;

DO $pn$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_players_before int; v_players_after int; v_filled int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.players p
              WHERE p.collection_id = c_ts
                AND EXISTS (SELECT 1 FROM public.editions e
                             WHERE e.collection_id = c_ts AND lower(trim(e.team_name)) = lower(trim(p.name)))) THEN
    RAISE EXCEPTION 'a Top Shot players row is named after a team — the linker would attach team Moments to it';
  END IF;
  SELECT count(*) INTO v_players_before FROM public.players WHERE collection_id = c_ts;

  INSERT INTO public.audit_20261004_team_moment_player_name_backup (edition_id, old_player_name)
    SELECT id, player_name FROM public.editions
     WHERE collection_id = c_ts AND player_id IS NULL AND player_name IS NULL
       AND NULLIF(trim(team_name), '') IS NOT NULL AND team_name <> '<invalid Value>'
    ON CONFLICT (edition_id) DO NOTHING;

  WITH u AS (
    UPDATE public.editions e
       SET player_name = trim(e.team_name), updated_at = now()
      FROM public.audit_20261004_team_moment_player_name_backup b
     WHERE e.id = b.edition_id AND e.collection_id = c_ts AND e.player_name IS NULL
    RETURNING 1) SELECT count(*) INTO v_filled FROM u;

  SELECT count(*) INTO v_players_after FROM public.players WHERE collection_id = c_ts;
  IF v_filled < 180 OR v_filled > 280 THEN
    RAISE EXCEPTION 'expected ~226 team Moments filled, got %', v_filled;
  END IF;
  IF v_players_after <> v_players_before THEN
    RAISE EXCEPTION 'players count moved % -> %', v_players_before, v_players_after;
  END IF;
  IF EXISTS (SELECT 1 FROM public.editions
              WHERE collection_id = c_ts AND player_id IS NULL AND player_name IS NULL
                AND NULLIF(trim(team_name), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'a team Moment still has no player_name';
  END IF;
  RAISE NOTICE 'filled player_name = team_name on % Top Shot team Moments', v_filled;
END
$pn$;

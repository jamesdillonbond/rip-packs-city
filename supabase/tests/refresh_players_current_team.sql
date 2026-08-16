-- DB invariant: public.refresh_players_current_team — pg_cron
-- `rpc-refresh-players-current-team` @ `40 9 * * *`.
--
-- WHAT IT DOES. Sets `players.team` to the team a player most recently appeared
-- for, derived from the moment catalogue's own `game_date` / `team_name`.
--
-- ── THE PROPERTY WORTH THE PIN ─────────────────────────────────────────────
-- ⚠ THE 18-MONTH WINDOW IS ANCHORED TO THE CATALOGUE'S MAX game_date, NOT TO
-- now(). `h.mg` is `max(game_date)` over the collection, and the cutoff is
-- `h.mg - interval '18 months'`. That is what stops the window sliding off the
-- end of the data: through an offseason, or an ingest stall, or a market that
-- has closed (UFC Strike has traded nothing since May 2026), a now()-anchored
-- window eventually contains ZERO moments and every player's team would be...
-- left alone, because `r` would be empty — quietly frozen rather than blanked,
-- which is the harder failure to notice.
-- ⚠ This is the same class as the panini gate CLAUDE.md documents: a threshold
-- measured against a rolling window of the very series it watches. The escape
-- there was a denominator the outage cannot depress; the escape here is an
-- anchor taken from the DATA rather than from the clock.
--
-- THE OTHERS:
--   • `DISTINCT ON (player_name) ... ORDER BY player_name, game_date DESC` — the
--     LATEST appearance wins. Reverse the sort and every traded player is
--     labelled with the team they left.
--   • `p.team IS DISTINCT FROM r.team_name` — change-detection, so `updated_at`
--     keeps meaning "when this player last CHANGED team" rather than "when the
--     cron last ran". `IS DISTINCT FROM`, not `<>`, so a first write onto a NULL
--     team happens at all.
--   • `team_name IS NOT NULL AND game_date IS NOT NULL` — an undated or
--     teamless edition cannot vote. ⚠ The teamless half matters in a specific
--     direction: without it, a latest edition that records no team wins the
--     DISTINCT ON and BLANKS a team already known, replacing real information
--     with an absence.
--   • Collection-scoped on BOTH the read and the write. ⚠ The explicit
--     `IF p_collection_id IS NULL THEN RETURN 0` is REDUNDANT and deliberately
--     not asserted: `e.collection_id = NULL` is NULL, so the read yields no rows
--     and the function returns 0 anyway (mutation-confirmed). It is kept as a
--     statement of intent, and it is what makes the behaviour obvious to a
--     reader instead of an accident of three-valued logic.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 9eeba20a688cedab9f707a0dac136c3e).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  collection_id uuid,
  player_name   text,
  team_name     text,
  game_date     date
);

CREATE TABLE public.players (
  collection_id uuid,
  name          text,
  team          text,
  updated_at    timestamptz
);

-- >>> BEGIN verbatim refresh_players_current_team (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_players_current_team(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
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
-- <<< END verbatim refresh_players_current_team <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''

-- ⚠ EVERY game_date here is deliberately YEARS in the past. That is the point:
-- against a now()-anchored 18-month window this whole fixture is empty and the
-- function does nothing. Anchored to the catalogue's own max game_date, it works
-- exactly as it does in production — which is what the anchor is FOR.
INSERT INTO public.editions (collection_id, player_name, team_name, game_date) VALUES
  -- Traded: the LATEST appearance must win.
  (:TS::uuid, 'Traded Player', 'Old Team', DATE '2021-01-01'),
  (:TS::uuid, 'Traded Player', 'New Team', DATE '2022-01-01'),
  -- Stale: last seen well outside 18 months of the catalogue max -> no vote.
  (:TS::uuid, 'Retired Player', 'Gone Team', DATE '2018-01-01'),
  -- Unchanged: already correct.
  (:TS::uuid, 'Same Player', 'Same Team', DATE '2022-01-01'),
  -- Never had a team recorded.
  (:TS::uuid, 'New Player', 'First Team', DATE '2022-01-01'),
  -- Rows that cannot vote at all.
  (:TS::uuid, 'Undated Player', 'Some Team', NULL),
  (:TS::uuid, 'Teamless Player', NULL, DATE '2022-01-01'),
  -- Another collection, with a CONFLICTING team for a name Top Shot also has.
  (:AD::uuid, 'Traded Player', 'AllDay Team', DATE '2022-06-01');

INSERT INTO public.players (collection_id, name, team, updated_at) VALUES
  (:TS::uuid, 'Traded Player',   'Old Team',  '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'Retired Player',  'Gone Team', '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'Same Player',     'Same Team', '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'New Player',      NULL,        '2026-01-01T00:00:00Z'),
  (:TS::uuid, 'Undated Player',  NULL,        '2026-01-01T00:00:00Z'),
  -- ⚠ Teamless Player already HAS a known team. That is what makes the
  -- `team_name IS NOT NULL` filter observable: without it, their latest edition
  -- (which records no team) wins the DISTINCT ON and BLANKS a team we know.
  -- With the player's team left NULL, the mutation passes for the wrong reason.
  (:TS::uuid, 'Teamless Player', 'Known Team', '2026-01-01T00:00:00Z'),
  (:AD::uuid, 'Traded Player',   'AllDay Team', '2026-01-01T00:00:00Z');

SELECT _assert_eq(
  public.refresh_players_current_team()::text, '2',
  'only the players whose team actually changed are written'
);

SELECT _assert_eq(
  (SELECT team FROM public.players WHERE collection_id = :TS::uuid AND name = 'Traded Player'),
  'New Team',
  'the LATEST appearance wins — reverse the sort and every traded player wears the team they left'
);

SELECT _assert_eq(
  (SELECT coalesce(team,'NULL') FROM public.players WHERE name = 'New Player'),
  'First Team',
  'a NULL -> value first write happens (IS DISTINCT FROM, not <>)'
);

-- ⚠ Outside the 18-month window: no vote. Note the team is LEFT AS IT WAS, not
-- blanked — a player who stopped appearing keeps their last known team.
SELECT _assert_eq(
  (SELECT team || '/' || (updated_at = '2026-01-01T00:00:00Z')::text
     FROM public.players WHERE name = 'Retired Player'),
  'Gone Team/true',
  'a player outside the window keeps their last known team and is not rewritten'
);

SELECT _assert_eq(
  (SELECT (updated_at = '2026-01-01T00:00:00Z')::text FROM public.players WHERE name = 'Same Player'),
  'true',
  'an UNCHANGED team leaves updated_at alone — it means "last changed", not "cron last ran"'
);

SELECT _assert_eq(
  (SELECT coalesce(team,'NULL') FROM public.players WHERE name = 'Undated Player'),
  'NULL',
  'an UNDATED edition cannot vote'
);

-- ⚠ A TEAMLESS edition cannot vote either — and the direction matters: without
-- the filter it would win the DISTINCT ON and BLANK a team we already know,
-- replacing real information with an absence.
SELECT _assert_eq(
  (SELECT coalesce(team,'NULL') FROM public.players WHERE name = 'Teamless Player'),
  'Known Team',
  'an edition with no team recorded cannot BLANK the team we already have'
);

-- ⚠ The same player name exists in TWO collections with different teams. Without
-- the collection scope on the write, one collection's catalogue would relabel
-- the other's player.
SELECT _assert_eq(
  (SELECT team FROM public.players WHERE collection_id = :AD::uuid AND name = 'Traded Player'),
  'AllDay Team',
  'another collection''s player of the SAME NAME is never relabelled'
);

-- ── The anchor, demonstrated ───────────────────────────────────────────────
-- ⚠ Push the catalogue's newest game far forward and the window moves WITH it:
-- the previously-current appearances fall out and stop voting. That is the
-- anchor tracking the data. Anchored to now() instead, this whole fixture --
-- every date years in the past -- would already have been empty above.
UPDATE public.players SET team = NULL WHERE collection_id = :TS::uuid;
INSERT INTO public.editions (collection_id, player_name, team_name, game_date)
VALUES (:TS::uuid, 'Recent Player', 'Recent Team', DATE '2026-01-01');

SELECT public.refresh_players_current_team();

SELECT _assert_eq(
  (SELECT coalesce(team,'NULL') FROM public.players WHERE collection_id = :TS::uuid AND name = 'Traded Player'),
  'NULL',
  'moving the catalogue max forward moves the window with it — the 2022 appearances stop voting'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.editions
    WHERE collection_id = :TS::uuid AND player_name = 'Recent Player'),
  '1',
  '...and the newly-current player is what the window is now anchored to'
);

-- ── The NULL guard ─────────────────────────────────────────────────────────
SELECT _assert_eq(
  public.refresh_players_current_team(NULL)::text, '0',
  'a NULL collection returns 0 rather than falling through to an unscoped write'
);

ROLLBACK;

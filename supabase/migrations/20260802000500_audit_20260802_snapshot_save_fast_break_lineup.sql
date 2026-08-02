-- Snapshot migration: commit the VERBATIM live body of public.save_fast_break_lineup
-- so the DB-invariant test (supabase/tests/save_fast_break_lineup.sql) has a committed
-- source the drift guard can compare against. MCP-applied, no prior committed
-- migration → previously UNPINNABLE; byte-identical snapshot per the documented
-- remedy (CLAUDE.md "Testing & CI coverage").
--
-- save_fast_break_lineup is the write path for the Fast Break game lineup. Two of
-- its guards are game-integrity load-bearing: (1) a cross-user AUTHZ check —
-- auth.uid(), when present, must equal p_user_id or it RAISEs forbidden_cross_user
-- (42501); (2) a per-run USE BUDGET — a Moment player can only be played as many
-- times as its tier allows, so adding a player whose (times_used + 1) would exceed
-- total_allowed returns exceeds_use_budget and writes NOTHING. It also diffs the
-- lineup to increment/decrement fast_break_player_uses and reports idempotent saves.
-- Re-applying this is a no-op (CREATE OR REPLACE with the live source).

CREATE OR REPLACE FUNCTION public.save_fast_break_lineup(p_user_id uuid, p_wallet_addr text, p_run_id uuid, p_game_date date, p_players jsonb, p_captain_nba_player_id uuid, p_eligibility jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing_lineup fast_break_lineups%ROWTYPE;
  v_existing_player_ids uuid[];
  v_new_player_ids uuid[];
  v_added uuid[];
  v_removed uuid[];
  v_lineup_id uuid;
  v_idempotent boolean := false;
  v_overage_player uuid;
  v_overage_times_used int;
  v_overage_total_allowed int;
  v_now timestamptz := now();
BEGIN
  -- AUTHZ: caller must be the user they claim to be (service_role bypasses)
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg((p->>'nbaPlayerId')::uuid), ARRAY[]::uuid[])
    INTO v_new_player_ids
    FROM jsonb_array_elements(p_players) AS p;

  SELECT * INTO v_existing_lineup
    FROM fast_break_lineups
   WHERE user_id = p_user_id AND run_id = p_run_id AND game_date = p_game_date
     FOR UPDATE;

  IF FOUND THEN
    SELECT COALESCE(array_agg((p->>'nbaPlayerId')::uuid), ARRAY[]::uuid[])
      INTO v_existing_player_ids
      FROM jsonb_array_elements(v_existing_lineup.players) AS p;
  ELSE
    v_existing_player_ids := ARRAY[]::uuid[];
  END IF;

  SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO v_added
    FROM unnest(v_new_player_ids) AS x
   WHERE NOT (x = ANY(v_existing_player_ids));
  SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO v_removed
    FROM unnest(v_existing_player_ids) AS x
   WHERE NOT (x = ANY(v_new_player_ids));

  v_idempotent := (cardinality(v_added) = 0
                   AND cardinality(v_removed) = 0
                   AND cardinality(v_existing_player_ids) > 0);

  IF cardinality(v_added) + cardinality(v_removed) > 0 THEN
    PERFORM 1
      FROM fast_break_player_uses
     WHERE user_id = p_user_id AND run_id = p_run_id
       AND nba_player_id = ANY(v_added || v_removed)
     FOR UPDATE;
  END IF;

  IF cardinality(v_added) > 0 THEN
    SELECT a.player_id,
           COALESCE(u.times_used, 0),
           COALESCE(u.total_allowed, e_map.e_total_allowed, 0)
      INTO v_overage_player, v_overage_times_used, v_overage_total_allowed
      FROM unnest(v_added) AS a(player_id)
      LEFT JOIN (
        SELECT (e->>'nba_player_id')::uuid AS player_id,
               (e->>'total_allowed')::smallint AS e_total_allowed,
               e->>'highest_tier' AS e_highest_tier
          FROM jsonb_array_elements(p_eligibility) AS e
      ) e_map ON e_map.player_id = a.player_id
      LEFT JOIN fast_break_player_uses u
             ON u.user_id = p_user_id AND u.run_id = p_run_id
            AND u.nba_player_id = a.player_id
     WHERE COALESCE(u.times_used, 0) + 1 > COALESCE(u.total_allowed, e_map.e_total_allowed, 0)
     LIMIT 1;
    IF v_overage_player IS NOT NULL THEN
      RETURN jsonb_build_object(
        'error', 'exceeds_use_budget',
        'player_id', v_overage_player,
        'times_used', v_overage_times_used,
        'total_allowed', v_overage_total_allowed
      );
    END IF;
  END IF;

  INSERT INTO fast_break_lineups (
    user_id, wallet_addr, run_id, game_date, players,
    captain_nba_player_id, status, created_at, updated_at
  )
  VALUES (
    p_user_id, p_wallet_addr, p_run_id, p_game_date, p_players,
    p_captain_nba_player_id, 'planned', v_now, v_now
  )
  ON CONFLICT (user_id, run_id, game_date) DO UPDATE
    SET players = EXCLUDED.players,
        captain_nba_player_id = EXCLUDED.captain_nba_player_id,
        wallet_addr = EXCLUDED.wallet_addr,
        updated_at = v_now
  RETURNING id INTO v_lineup_id;

  IF cardinality(v_added) > 0 THEN
    INSERT INTO fast_break_player_uses (
      user_id, run_id, nba_player_id, highest_tier_owned, total_allowed,
      times_used, dates_used, best_moment_id, best_serial, updated_at
    )
    SELECT
      p_user_id, p_run_id, a.player_id,
      COALESCE((e->>'highest_tier')::tier_type, 'COMMON'::tier_type),
      COALESCE((e->>'total_allowed')::smallint, 1::smallint),
      1,
      ARRAY[p_game_date]::date[],
      p_in->>'momentId',
      NULLIF(p_in->>'serial', '')::int,
      v_now
    FROM unnest(v_added) AS a(player_id)
    JOIN jsonb_array_elements(p_players) AS p_in
      ON (p_in->>'nbaPlayerId')::uuid = a.player_id
    LEFT JOIN jsonb_array_elements(p_eligibility) AS e
      ON (e->>'nba_player_id')::uuid = a.player_id
    ON CONFLICT (user_id, run_id, nba_player_id) DO UPDATE
      SET times_used = fast_break_player_uses.times_used + 1,
          dates_used = array_remove(fast_break_player_uses.dates_used, p_game_date) || ARRAY[p_game_date]::date[],
          best_moment_id = COALESCE(fast_break_player_uses.best_moment_id, EXCLUDED.best_moment_id),
          best_serial = COALESCE(fast_break_player_uses.best_serial, EXCLUDED.best_serial),
          updated_at = v_now;
  END IF;

  IF cardinality(v_removed) > 0 THEN
    UPDATE fast_break_player_uses
       SET times_used = GREATEST(0, times_used - 1),
           dates_used = array_remove(dates_used, p_game_date),
           updated_at = v_now
     WHERE user_id = p_user_id AND run_id = p_run_id
       AND nba_player_id = ANY(v_removed);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'lineup_id', v_lineup_id,
    'added', to_jsonb(v_added),
    'removed', to_jsonb(v_removed),
    'use_counts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'nba_player_id', nba_player_id,
        'times_used', times_used,
        'total_allowed', total_allowed
      )), '[]'::jsonb)
      FROM fast_break_player_uses
      WHERE user_id = p_user_id AND run_id = p_run_id
        AND nba_player_id = ANY(v_new_player_ids)
    )
  );
END;
$function$;

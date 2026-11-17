-- audit_20260904_wmc_metadata_reconcile_cursor_is_simply_the_highest_edition_actually_processed
-- Applied to prod via MCP apply_migration 2026-09-04 14:25Z (version 20260904142504).
-- Measured after apply, three consecutive ticks: 12,311 / 14,683 / 16,151 rows corrected, each
--   inside the 40 s budget, cursor advancing 104:3655 -> 124:4417 -> 124:4586 -> 124:4766.
--   Spot-checked: "Base Set6" -> "Base Set", "Archive Set 2014-" -> "Archive Set 2014-19".
--
-- Immediate follow-up to the chunked rewrite (20260904142428): its cursor arithmetic was clever and
-- hard to prove. A cursor that is wrong in the "stopped early" branch SKIPS editions silently, which
-- is the one failure this whole pass exists to fix, so it is replaced with the rule that needs no
-- argument:
--
--   the cursor is the HIGHEST edition key this tick actually popped and processed.
--
-- Nothing else. If the tick popped nothing the cursor does not move; when the window is exhausted
-- the cursor is the window's own maximum, and the next tick's window starts after it; when the
-- catalog is exhausted it wraps to '' so later corruption is caught. ⓘ The walk is LEXICOGRAPHIC on
-- a text key, so '98:3132' sorts after '124:4766' — that is consistent end to end and is not a bug,
-- but it means "editions below the cursor" is not "low set ids".
-- anon-exec: no — writer; REVOKE/GRANT re-stated.
-- REVERT: the body in 20260904141708 (single-statement, 400 editions, `19,29 * * * *`).

CREATE OR REPLACE FUNCTION public.reconcile_wmc_metadata_from_editions(p_editions integer DEFAULT 1200, p_budget_seconds integer DEFAULT 45)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started  timestamptz := clock_timestamp();
  v_deadline timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_budget_seconds, 5));
  v_cursor  text;
  v_high    text;      -- highest edition key actually processed this tick
  v_avail   integer := 0;
  v_n       integer := 0;
  v_batch   integer;
  v_popmax  text;
  v_chunk   constant integer := 25;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('reconcile_wmc_metadata_from_editions')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  INSERT INTO public.wmc_metadata_reconcile_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_key INTO v_cursor FROM public.wmc_metadata_reconcile_state WHERE id = 1;
  v_high := v_cursor;

  DROP TABLE IF EXISTS _wmr_eds;
  CREATE TEMP TABLE _wmr_eds ON COMMIT DROP AS
    SELECT e.external_id, e.tier::text AS tier, e.set_name, e.player_name, e.team_name
      FROM public.editions e
     WHERE e.collection_id = v_ts
       AND e.external_id > v_cursor
     ORDER BY e.external_id
     LIMIT GREATEST(p_editions, 1);
  SELECT count(*) INTO v_avail FROM _wmr_eds;
  CREATE INDEX ON _wmr_eds (external_id);
  ANALYZE _wmr_eds;

  WHILE v_avail > 0 LOOP
    WITH popped AS (
      DELETE FROM _wmr_eds
       WHERE external_id IN (SELECT external_id FROM _wmr_eds ORDER BY external_id LIMIT v_chunk)
      RETURNING external_id, tier, set_name, player_name, team_name
    ),
    cand AS (
      SELECT w.id, w.edition_key,
             w.tier AS old_tier, w.set_name AS old_set_name, w.player_name AS old_player_name, w.team_name AS old_team_name,
             CASE WHEN p.tier IS NOT NULL THEN p.tier ELSE w.tier END AS new_tier,
             CASE WHEN p.set_name IS NOT NULL THEN p.set_name ELSE w.set_name END AS new_set_name,
             CASE WHEN COALESCE(w.player_name, '') = '' THEN COALESCE(p.player_name, p.team_name, w.player_name) ELSE w.player_name END AS new_player_name,
             CASE WHEN COALESCE(w.team_name, '')   = '' THEN COALESCE(p.team_name, w.team_name)                 ELSE w.team_name   END AS new_team_name
        FROM popped p
        JOIN public.wallet_moments_cache w
          ON w.collection_id = v_ts AND w.edition_key = p.external_id
    ),
    changed AS (
      SELECT * FROM cand
       WHERE new_tier        IS DISTINCT FROM old_tier
          OR new_set_name    IS DISTINCT FROM old_set_name
          OR new_player_name IS DISTINCT FROM old_player_name
          OR new_team_name   IS DISTINCT FROM old_team_name
    ),
    logged AS (
      INSERT INTO public.audit_20260904_wmc_metadata_reconcile (wmc_id, edition_key, old_tier, old_set_name, old_player_name, old_team_name)
      SELECT id, edition_key, old_tier, old_set_name, old_player_name, old_team_name FROM changed
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET tier        = c.new_tier,
             set_name    = c.new_set_name,
             player_name = c.new_player_name,
             team_name   = c.new_team_name
        FROM changed c
       WHERE w.id = c.id
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM upd), (SELECT max(external_id) FROM popped)
      INTO v_batch, v_popmax;

    v_n := v_n + COALESCE(v_batch, 0);
    IF v_popmax IS NOT NULL AND v_popmax > v_high THEN
      v_high := v_popmax;      -- ← the whole cursor rule
    END IF;

    EXIT WHEN v_popmax IS NULL;                              -- nothing left to pop
    EXIT WHEN NOT EXISTS (SELECT 1 FROM _wmr_eds);
    EXIT WHEN clock_timestamp() > v_deadline;
  END LOOP;

  UPDATE public.wmc_metadata_reconcile_state
     SET cursor_key = CASE WHEN v_avail > 0 THEN v_high ELSE '' END,   -- wrap when the catalog is exhausted
         cycles     = cycles + CASE WHEN v_avail > 0 THEN 0 ELSE 1 END,
         updated_at = now()
   WHERE id = 1;

  IF v_n > 0 THEN
    PERFORM public.log_pipeline_run('wmc-metadata-reconcile', v_started, v_avail, v_n, 0, true, NULL, 'nba_top_shot', v_cursor, v_high,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                 'editions_window', v_avail, 'rows_corrected', v_n, 'budget_s', p_budget_seconds, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('window', v_avail, 'corrected', v_n, 'cursor', v_high);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.reconcile_wmc_metadata_from_editions(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_wmc_metadata_from_editions(integer, integer) TO postgres, service_role, cron_heavy;

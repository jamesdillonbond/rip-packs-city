-- audit_20260907: reconcile_wmc_metadata_from_editions() logs EVERY tick, not
-- only the ones that corrected a row.
--
-- WHY (inbox 2026-09-07T0611Z daytime-monitor, re-derived live 2026-09-07 08:5x PT
-- before acting). The watchlist arm shipped 14 h earlier (20260907015019) states
-- its own intent in its notes: "Health is SILENCE, not rows_written: post-drain
-- it writes 2-220 rows/hour by design." The IMPLEMENTATION does not deliver that
-- intent. detect_stalled_pipelines() measures max(started_at) over pipeline_runs,
-- and this function ended with `IF v_n > 0 THEN PERFORM log_pipeline_run(...)`, so
-- a tick that reconciled nothing wrote NO ROW AT ALL. The arm therefore measured
-- silence-of-WRITES while its notes claim it measures silence-of-TICKS -- the
-- CLAUDE.md shape "ask what a passing guard is structurally SILENT about".
--
-- MEASURED (12 h window, 2026-09-07 ~15:50Z):
--   cron.job_run_details jobid 456      : 24 runs, ALL 'succeeded'
--   pipeline_runs 'wmc-metadata-reconcile' : 10 rows, all ok=true
--   -> 14 of 24 ticks ran, succeeded, and were invisible to the detector.
-- Gap distribution over 7 d (235 gaps): avg 18.8 min, MAX 180 min, and 3 gaps
-- exceeded the 100-min threshold -- 2 of those 3 in the last 24 h alone. It is
-- accelerating exactly as the filing predicted, because the cadence moved
-- */10 -> 15,45 (30 min) and the drain converged 09-04, so quiet stretches are
-- now normal. The monitor's own positive control: jobid 456 succeeded at
-- 05:45 / 05:15 / 04:45Z while the detector called it silent 113 min.
--
-- WHY NOT the other two options the filing offered:
--  (b) raise max_silent_minutes -- the observed max gap is 180 min, so it would
--      have to go past 200 to actually suppress, throwing away the 3-missed-tick
--      sensitivity the arm was calibrated for 14 h ago. A threshold fudge that
--      makes a real wedge take 3.3 h to surface.
--  (c) validate this arm off cron.job_run_details -- correct, but it special-cases
--      ONE pipeline inside a detector that is generic over the watchlist, and
--      pg_cron success is the JOB returning, not the work succeeding
--      (memory: a pg_cron job status is NOT its work's outcome).
-- ⚠ (a) AS USUALLY MEANT IS ALSO REFUTED, and a parallel session (8a7ee0be4,
-- ~09:00 PT, read before this was rebased onto it) refuted it from this file's
-- own trap: "a marker under the REAL name would refresh last_run every tick and
-- silence detect_stalled_pipelines() on exactly the outage it exists to expose."
-- A `-heartbeat`-suffixed row dodges that but is then invisible to an arm keyed
-- on the real name, so the usual form either defeats the arm or does nothing.
--
-- WHAT THIS MIGRATION SHIPS is the one variant that refutation leaves standing,
-- in its own words: "have the reconciler log EVERY completed tick, zero-write
-- included. For a pg_cron SQL function that is honest liveness -- the row is
-- written at tick END inside the same transaction, so it cannot claim a tick
-- that died." This is NOT a pre-work marker and NOT a suffixed pipeline name:
-- the log call sits after the cursor update, in the same transaction, carrying
-- the real rows_found and rows_written. A tick that dies mid-work rolls the row
-- back with it, so a genuine outage still surfaces.
--
-- That session concluded (c) and deliberately did not ship, because (c) is a
-- migration to the PINNED detect_stalled_pipelines() inside the 24-48 h
-- collision window on jobid 456's lane. This does not touch the detector -- it
-- fixes the DATA the generic detector reads, so every arm keyed on
-- pipeline_runs benefits and no pinned object moves. (c) is therefore no longer
-- needed FOR THIS PIPELINE, but stays the better answer for any watched
-- pipeline whose function we do not control.
--
-- BLAST RADIUS (enumerated, not assumed): the only readers of the string
-- 'wmc-metadata-reconcile' are this function and the pipeline_cadence_watchlist
-- row -- no view, no matview, no other function, no cron command, and no
-- application code (ripgrep over the tree: migrations only).
-- check_pipelines_running_but_not_succeeding() fires only on
-- `ok_runs = 0 AND work_done = 0`; the heartbeat is ok=true, so it CANNOT trip
-- that arm -- this trades no alarm for another. ~48 extra rows/day against a
-- ~73 h retention: negligible.
--
-- HONESTY: the no-op row is a truthful record of a COMPLETED tick, not a marker
-- for a killed one -- rows_found carries the window it actually examined and
-- rows_written the 0 it actually wrote. `extra.no_op` is the shape-independent
-- field an observer keys on, so a reader can still separate "reconciled nothing"
-- from "reconciled something" without inferring it from a count.
--
-- WATCH / EXIT: detect_stalled_pipelines() should stop returning
-- wmc-metadata-reconcile entirely; pipeline_runs rows/12 h should rise from ~10
-- to ~24 and match cron.job_run_details 1:1.
-- FALSIFIER: if a row still fails to appear on a tick that pg_cron records as
-- succeeded, the silence is NOT the logging gate and this diagnosis is wrong.
--
-- REVERT: re-apply migration 20260904142504 (the immediately-prior body of this
-- function), or wrap the PERFORM call below back into `IF v_n > 0 THEN ... END IF`.
--
-- anon-exec: NOT granted, measured not assumed — has_function_privilege at apply time reads anon=false, authenticated=false, service_role=true for reconcile_wmc_metadata_from_editions.
-- This is a BODY-ONLY `CREATE OR REPLACE`: it does not reset a function ACL, so a
-- REVOKE here would change nothing while reading like a hardening step. The
-- function was already locked down when it was created (20260904141708 /
-- 20260904142504) and its only caller is pg_cron jobid 456, running as postgres.
-- It is SECURITY DEFINER and writes to wallet_moments_cache, so anon EXECUTE
-- would be a real hole: if the measurement above ever reads true, that is a
-- finding, not a formality.

CREATE OR REPLACE FUNCTION public.reconcile_wmc_metadata_from_editions(p_editions integer DEFAULT 1200, p_budget_seconds integer DEFAULT 45)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
    SELECT e.external_id, e.tier::text AS tier, e.set_name, e.player_name, e.team_name,
           e.circulation_count
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
      RETURNING external_id, tier, set_name, player_name, team_name, circulation_count
    ),
    cand AS (
      SELECT w.id, w.edition_key,
             w.tier AS old_tier, w.set_name AS old_set_name, w.player_name AS old_player_name,
             w.team_name AS old_team_name, w.mint_count AS old_mint_count,
             CASE WHEN p.tier IS NOT NULL THEN p.tier ELSE w.tier END AS new_tier,
             CASE WHEN p.set_name IS NOT NULL THEN p.set_name ELSE w.set_name END AS new_set_name,
             CASE WHEN COALESCE(w.player_name, '') = '' THEN COALESCE(p.player_name, p.team_name, w.player_name) ELSE w.player_name END AS new_player_name,
             CASE WHEN COALESCE(w.team_name, '')   = '' THEN COALESCE(p.team_name, w.team_name)                 ELSE w.team_name   END AS new_team_name,
             -- The denominator now has ONE meaning (this printing's own mint) and the catalog owns
             -- it. A NULL catalog value never removes a number wmc already has.
             CASE WHEN p.circulation_count IS NOT NULL THEN p.circulation_count ELSE w.mint_count END AS new_mint_count
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
          OR new_mint_count  IS DISTINCT FROM old_mint_count
    ),
    logged AS (
      INSERT INTO public.audit_20260904_wmc_metadata_reconcile (wmc_id, edition_key, old_tier, old_set_name, old_player_name, old_team_name)
      SELECT id, edition_key, old_tier, old_set_name, old_player_name, old_team_name FROM changed
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    -- mint_count gets its OWN audit table rather than a column on the one above, because that one
    -- is ON CONFLICT DO NOTHING and rows fixed on an earlier tick would silently record no old
    -- mint at all — a revert path with holes in it is not a revert path.
    logged_mint AS (
      INSERT INTO public.audit_20260904_wmc_mint_count (wmc_id, edition_key, old_mint_count, new_mint_count)
      SELECT id, edition_key, old_mint_count, new_mint_count FROM changed
       WHERE new_mint_count IS DISTINCT FROM old_mint_count AND new_mint_count IS NOT NULL
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET tier        = c.new_tier,
             set_name    = c.new_set_name,
             player_name = c.new_player_name,
             team_name   = c.new_team_name,
             mint_count  = c.new_mint_count
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

  -- EVERY tick logs. `IF v_n > 0` here meant a tick that reconciled nothing was
  -- absent from pipeline_runs entirely, so the cadence arm's clock tracked the
  -- WORKLOAD instead of the JOB and fired `medium` on a job pg_cron had just
  -- recorded as succeeded. extra.no_op is the field an observer keys on.
  PERFORM public.log_pipeline_run('wmc-metadata-reconcile', v_started, v_avail, v_n, 0, true, NULL, 'nba_top_shot', v_cursor, v_high,
            jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                               'editions_window', v_avail, 'rows_corrected', v_n, 'budget_s', p_budget_seconds, 'via', 'pg_cron',
                               'no_op', (v_n = 0)));
  RETURN jsonb_build_object('window', v_avail, 'corrected', v_n, 'cursor', v_high);
END
$function$;

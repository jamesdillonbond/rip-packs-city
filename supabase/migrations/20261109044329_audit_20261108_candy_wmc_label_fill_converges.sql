-- audit_20261108_candy_wmc_label_fill_converges
--
-- Fix for 20261109024510 (candy_wmc_label_fill_step), read at the 8:35 PM PT check: 17 steps
-- had filled 241,200 rows, yet 1,073,082 Candy rows still had player_name NULL — 347,033
-- fillable, 726,049 NOT fillable (their edition has no player or team: DC art, pins,
-- Digi-Cast trophies…). Three defects: (1) the key picker chose keys from ANY NULL row, so
-- steps were spent on keys that can never fill; (2) the cursor is lexical and the
-- collections census kept inserting unlabelled rows BEHIND it until its labelled payload
-- deployed (6:52 PM PT), so one pass could not finish the job; (3) from 8:11 PM PT every step hit the 120 s
-- statement_timeout — 150 keys of 2022 Leadoff ICONs is ~14k row updates — so the cursor
-- stopped at 17 steps. Steps are now bounded by a 3,000-row budget, and the
-- picker scans 60 keys, not 150 (it read 28k cold blocks / 40 s for 400 keys). The picker now takes only
-- keys whose edition can fill a NULL, and the end of a pass restarts from the top; a pass
-- that finds nothing from the top unschedules the job. Same signature, same ACL.
--
-- when-others-timeout-blind: n/a — no exception handler.
-- anon-exec: intentional — same signature, ACL preserved (service_role only) (candy_wmc_label_fill_step)
--
-- Rollback: re-apply candy_wmc_label_fill_step from 20261109024510 and reschedule the job with
-- 'SELECT public.candy_wmc_label_fill_step(150)'.

CREATE OR REPLACE FUNCTION public.candy_wmc_label_fill_step(p_keys integer DEFAULT 150)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_from text;
  v_keys text[];
  v_last text;
  v_rows integer := 0;
  v_started timestamptz := clock_timestamp();
  v_row_budget constant integer := 3000;
BEGIN
  SELECT last_key INTO v_from FROM candy_wmc_label_fill_cursor WHERE id = 1 FOR UPDATE;
  -- Only keys whose edition can actually fill something: 726k rows (DC art, pins…) have
  -- editions with no player / team, and re-visiting them would never converge.
  -- Bounded by ROWS, not keys: a 150-key step over 2022 Leadoff ICONs touched ~14k rows
  -- and hit the 120 s statement_timeout six ticks running (8:11–8:35 PM PT). Keys are taken
  -- in order until v_row_budget rows; the first key is always taken.
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM (
   SELECT k, n, sum(n) OVER (ORDER BY k) AS cum FROM (
    SELECT w.edition_key AS k, count(*) AS n
      FROM wallet_moments_cache w
      JOIN editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND w.edition_key IS NOT NULL
       AND w.edition_key > v_from
       AND (  (w.tier IS NULL AND e.tier IS NOT NULL)
           OR (w.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL)
           OR (w.set_name IS NULL AND e.set_name IS NOT NULL)
           OR (w.mint_count IS NULL AND e.circulation_count IS NOT NULL)
           OR (w.team_name IS NULL AND e.team_name IS NOT NULL))
     GROUP BY w.edition_key
     ORDER BY w.edition_key
     LIMIT p_keys
   ) a
  ) q WHERE q.cum - q.n < v_row_budget;

  IF v_keys IS NULL AND v_from <> '' THEN
    -- End of a pass. Rows inserted behind the cursor during the pass (the collections
    -- census, before its rows were born labelled) need another: restart from the top.
    -- A pass that finds nothing from '' is the end.
    UPDATE candy_wmc_label_fill_cursor SET last_key = '', steps = steps + 1 WHERE id = 1;
    PERFORM log_pipeline_run('candy-wmc-label-fill', v_started, 0, 0, 0, true, NULL,
      'candy_mlb', v_from, '', jsonb_build_object('pass_restarted', true));
    RETURN jsonb_build_object('pass_restarted', true);
  END IF;
  IF v_keys IS NULL THEN
    UPDATE candy_wmc_label_fill_cursor SET done_at = now() WHERE id = 1;
    PERFORM cron.unschedule('rpc-candy-wmc-label-fill');
    PERFORM log_pipeline_run('candy-wmc-label-fill', v_started, 0, 0, 0, true, NULL,
      'candy_mlb', v_from, v_from, jsonb_build_object('done', true));
    RETURN jsonb_build_object('done', true);
  END IF;

  v_last := v_keys[array_length(v_keys, 1)];
  WITH u AS (
    UPDATE wallet_moments_cache w
       SET tier        = COALESCE(w.tier,        e.tier::text),
           player_name = COALESCE(w.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(w.set_name,    e.set_name),
           mint_count  = COALESCE(w.mint_count,  e.circulation_count),
           team_name   = COALESCE(w.team_name,   e.team_name)
      FROM editions e
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND w.edition_key = ANY (v_keys)
       AND e.collection_id = w.collection_id
       AND e.external_id = w.edition_key
       AND (w.tier IS NULL OR w.player_name IS NULL OR w.set_name IS NULL OR w.mint_count IS NULL OR w.team_name IS NULL)
       AND (  (w.tier IS NULL AND e.tier IS NOT NULL)
           OR (w.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL)
           OR (w.set_name IS NULL AND e.set_name IS NOT NULL)
           OR (w.mint_count IS NULL AND e.circulation_count IS NOT NULL)
           OR (w.team_name IS NULL AND e.team_name IS NOT NULL))
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM u;

  UPDATE candy_wmc_label_fill_cursor
     SET last_key = v_last, steps = steps + 1, rows_filled = rows_filled + v_rows
   WHERE id = 1;
  PERFORM log_pipeline_run('candy-wmc-label-fill', v_started, array_length(v_keys, 1), v_rows, 0, true, NULL,
    'candy_mlb', v_from, v_last, jsonb_build_object('keys', array_length(v_keys, 1), 'rows_filled', v_rows));
  RETURN jsonb_build_object('keys', array_length(v_keys, 1), 'rows_filled', v_rows, 'cursor', v_last);
END
$$;

-- Same jobname keeps jobid 844; only the key count changes.
SELECT cron.schedule('rpc-candy-wmc-label-fill', '3-59/4 * * * *', 'SELECT public.candy_wmc_label_fill_step(60)');

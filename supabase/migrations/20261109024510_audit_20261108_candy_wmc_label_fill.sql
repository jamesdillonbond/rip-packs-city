-- audit_20261108_candy_wmc_label_fill
--
-- The full-inventory Candy census (20261108215733 / 222220) inserts holdings without the
-- label columns (tier, player_name, set_name, mint_count, team_name), so on 2026-11-08 PM
-- 938,497 of 966,561 Candy wallet_moments_cache rows had them NULL. The registry census'
-- whole-collection denorm, backfill_wmc_metadata_from_editions(NULL, candy), then tried to
-- fill ~938k rows on EVERY page: the 5:10 PM PT candy-editions run crawled at ~900 rows per
-- 2 minutes, was killed at the 800 s wall after the Base set (heartbeat, no completion row),
-- and never reached All-Star / Gold / Quest / Team Balls. (The route now runs that denorm
-- once per run, and the collections census now writes the labels itself.)
--
-- This drains the existing NULLs in bounded steps instead of one statement:
-- candy_wmc_label_fill_step(p_keys) takes the next p_keys distinct edition keys (cursor,
-- via the partial index idx_wmc_metadata_fillable) and fills their rows from `editions`
-- with the same COALESCE rules (only ever a NULL is filled). pg_cron every 4 minutes
-- (3,7,…,59) — off the banned minutes — and the job UNSCHEDULES ITSELF when no key is left
-- past the cursor. Each step logs `candy-wmc-label-fill` to pipeline_runs. Sized live: 150 keys
-- = 8,050 rows in 9.4 s, so the cron step is 400 keys (~16.4k Candy editions → ~41 steps).
--
-- when-others-timeout-blind: n/a — no exception handler.
-- anon-exec: intentional — new function, REVOKEd from PUBLIC/anon/authenticated below; service_role only (candy_wmc_label_fill_step)
--
-- Rollback: SELECT cron.unschedule('rpc-candy-wmc-label-fill'); DROP FUNCTION public.candy_wmc_label_fill_step(integer);
--   DROP TABLE public.candy_wmc_label_fill_cursor;  (filled labels stay — they are COALESCE fills from editions)

CREATE TABLE public.candy_wmc_label_fill_cursor (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_key    text NOT NULL DEFAULT '',
  steps       integer NOT NULL DEFAULT 0,
  rows_filled bigint NOT NULL DEFAULT 0,
  done_at     timestamptz
);
ALTER TABLE public.candy_wmc_label_fill_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_wmc_label_fill_cursor FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_wmc_label_fill_cursor TO service_role;
INSERT INTO public.candy_wmc_label_fill_cursor (id) VALUES (1);

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
BEGIN
  SELECT last_key INTO v_from FROM candy_wmc_label_fill_cursor WHERE id = 1 FOR UPDATE;
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM (
    SELECT DISTINCT w.edition_key AS k
      FROM wallet_moments_cache w
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND w.edition_key IS NOT NULL
       AND (w.tier IS NULL OR w.player_name IS NULL OR w.set_name IS NULL OR w.mint_count IS NULL OR w.team_name IS NULL)
       AND w.edition_key > v_from
     ORDER BY w.edition_key
     LIMIT p_keys
  ) q;

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

REVOKE ALL ON FUNCTION public.candy_wmc_label_fill_step(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_wmc_label_fill_step(integer) TO service_role;

SELECT cron.schedule('rpc-candy-wmc-label-fill', '3-59/4 * * * *', 'SELECT public.candy_wmc_label_fill_step(400)');

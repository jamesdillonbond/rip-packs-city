-- audit_20261027: refresh_hot_floors_snapshot refuses a malformed payload and logs the row it wrote (fix to 20261027140941).
--
-- Code review of 20261027140941 (same day): (a) a payload whose `editions` is not a JSON array was stored and logged
-- ok=true with 0 editions — the page then read it as a failure (Panini) or an empty market (Top Shot), while the lane
-- reported success; both board functions always return an array (COALESCE(json_agg…,'[]')), so anything else is a
-- shape change and now RAISES: the previous snapshot stays and the run is recorded failed. (b) rows_written counted
-- editions, not rows written — a quiet market logged rows_written=0 beside a write that landed. Now rows_found = the
-- edition count, rows_written = 1 (the one snapshot row upserted).
-- anon-exec: unchanged (refresh_hot_floors_snapshot) — CREATE OR REPLACE, same signature; ACL preserved (anon EXECUTE false, read 2026-10-27 ~8:40 AM PT).
--
-- Revert: re-apply the function body from 20261027140941.

CREATE OR REPLACE FUNCTION public.refresh_hot_floors_snapshot(p_board text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_pipeline text;
  v_collection text;
  v_payload jsonb;
  v_n int;
BEGIN
  IF p_board = 'nba-top-shot' THEN
    v_pipeline := 'topshot-hot-floors-snapshot'; v_collection := 'nba_top_shot';
    v_payload := public.get_topshot_hot_floors(3)::jsonb;
  ELSIF p_board = 'panini-blockchain' THEN
    v_pipeline := 'panini-hot-floors-snapshot'; v_collection := 'panini_blockchain';
    v_payload := public.get_panini_hot_floors(7);
  ELSE
    RAISE EXCEPTION 'refresh_hot_floors_snapshot: unknown board %', p_board;
  END IF;
  IF jsonb_typeof(v_payload->'editions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'refresh_hot_floors_snapshot: % payload has no editions array (got %)', p_board, coalesce(jsonb_typeof(v_payload->'editions'), 'nothing');
  END IF;
  v_n := jsonb_array_length(v_payload->'editions');
  INSERT INTO public.hot_floors_snapshot (board, payload, computed_at)
  VALUES (p_board, v_payload, clock_timestamp())
  ON CONFLICT (board) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
  PERFORM public.log_pipeline_run(v_pipeline, v_started, v_n, 1, 0, true, NULL, v_collection, NULL, NULL,
    jsonb_build_object('duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000), 'editions', v_n));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- The previous snapshot stays (with its own computed_at); this run is recorded as failed — including a
  -- statement_timeout kill (57014), which WHEN OTHERS alone cannot see (R118).
  PERFORM public.log_pipeline_run(COALESCE(v_pipeline, 'hot-floors-snapshot'), v_started, 0, 0, 0, false, SQLERRM, v_collection, NULL, NULL, NULL);
END;
$function$;

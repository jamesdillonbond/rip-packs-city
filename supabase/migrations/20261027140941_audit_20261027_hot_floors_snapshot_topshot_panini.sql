-- audit_20261027: Top Shot and Panini Hot Floors read a snapshot instead of computing on the read path (#HF).
--
-- The All Day board moved to a 15-minute snapshot on 10-26 (20261027031715); its ledger entry left Top Shot and
-- Panini computing live, and both tripped the same 8 s read bound in the same minute (10-27 02:34Z / 02:36Z).
-- Measured 10-27 ~7:15 AM PT: get_topshot_hot_floors(3) 2,263 ms / 26.3k buffers, get_panini_hot_floors(7)
-- 2,088 ms / 16.6k buffers (9.0k read) — warm-ish, on a 300 s ISR page; pg_stat_statements max 10.9 s / 16.4 s.
-- One table keyed by board (not one table per board); All Day keeps its own table untouched.
-- Slots, from 2-day busy cron-seconds by minute: Top Shot 13,28,43,58 (every 15 min; :58 3,773 · :43 3,872 ·
-- :13 4,041 · :28 4,141); Panini 29,59 (every 30 min — its sales reach RPC 12–160 h late; :59 3,914 · :29 4,316).
-- On a failed refresh the previous row stays with its own computed_at, which the page shows.
--
-- Revert: SELECT cron.unschedule('topshot-hot-floors-snapshot'); SELECT cron.unschedule('panini-hot-floors-snapshot');
--         DROP FUNCTION public.refresh_hot_floors_snapshot(text); DROP TABLE public.hot_floors_snapshot;
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('topshot-hot-floors-snapshot','panini-hot-floors-snapshot');
--         (the pages then compute live again — lib/hot-floors/{fetchers,panini}.ts fall back when no row exists)

CREATE TABLE IF NOT EXISTS public.hot_floors_snapshot (
  board text PRIMARY KEY CHECK (board IN ('nba-top-shot', 'panini-blockchain')),
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.hot_floors_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hot_floors_snapshot FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.hot_floors_snapshot TO service_role;

-- anon-exec: revoked (refresh_hot_floors_snapshot) — pg_cron writer; REVOKE FROM PUBLIC, anon, authenticated below.
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
  v_n := CASE WHEN jsonb_typeof(v_payload->'editions') = 'array' THEN jsonb_array_length(v_payload->'editions') ELSE 0 END;
  INSERT INTO public.hot_floors_snapshot (board, payload, computed_at)
  VALUES (p_board, v_payload, clock_timestamp())
  ON CONFLICT (board) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
  PERFORM public.log_pipeline_run(v_pipeline, v_started, v_n, v_n, 0, true, NULL, v_collection, NULL, NULL,
    jsonb_build_object('duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- The previous snapshot stays (with its own computed_at); this run is recorded as failed — including a
  -- statement_timeout kill (57014), which WHEN OTHERS alone cannot see (R118).
  PERFORM public.log_pipeline_run(COALESCE(v_pipeline, 'hot-floors-snapshot'), v_started, 0, 0, 0, false, SQLERRM, v_collection, NULL, NULL, NULL);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.refresh_hot_floors_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_hot_floors_snapshot(text) TO postgres, service_role;

COMMENT ON TABLE public.hot_floors_snapshot IS
  'One row per board: get_topshot_hot_floors(3) every 15 min (pg_cron topshot-hot-floors-snapshot) and get_panini_hot_floors(7) every 30 min (panini-hot-floors-snapshot). /[collection]/hot-floors reads this instead of computing on the read path (both hit the 8 s read bound, 10-27). All Day has its own allday_hot_floors_snapshot. audit_20261027.';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES
  ('topshot-hot-floors-snapshot', 60, 'info',
   'pg_cron 13,28,43,58 (15 min). Precomputes /nba-top-shot/hot-floors (get_topshot_hot_floors(3)). A stall leaves the page on an older board with its own "updated N ago". audit_20261027.', 90),
  ('panini-hot-floors-snapshot', 90, 'info',
   'pg_cron 29,59 (30 min). Precomputes /panini-blockchain/hot-floors (get_panini_hot_floors(7)). A stall leaves the page on an older board with its own "updated N ago". audit_20261027.', 150)
ON CONFLICT DO NOTHING;

SELECT cron.schedule('topshot-hot-floors-snapshot', '13,28,43,58 * * * *', $$SELECT public.refresh_hot_floors_snapshot('nba-top-shot')$$);
SELECT cron.schedule('panini-hot-floors-snapshot', '29,59 * * * *', $$SELECT public.refresh_hot_floors_snapshot('panini-blockchain')$$);
SELECT public.refresh_hot_floors_snapshot('nba-top-shot');
SELECT public.refresh_hot_floors_snapshot('panini-blockchain');

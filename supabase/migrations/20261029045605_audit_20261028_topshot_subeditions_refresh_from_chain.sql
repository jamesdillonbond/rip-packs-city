-- 2026-10-28: topshot_subeditions keeps itself current from the chain.
-- The table (20261029035651) was a one-time seed of TopShot.getAllSubeditions(); the next parallel Dapper creates would
-- again be invisible to atlas_editions_drain()'s name->id map. refresh_topshot_subeditions() alternates two phases:
--   no request pending -> dispatch the script (Flow REST, sealed block) and record the request id;
--   a request pending  -> collect it: INSERT ids the table lacks; an id the chain names differently from the table is
--                         COUNTED and reported (ok=false), never overwritten — subedition names do not change on-chain,
--                         so a disagreement is a defect to read, not data to apply.
-- ok is derived from the read landing and every write succeeding; a missing response older than 30 min is a failure.
-- Two ticks 5 minutes apart, 4x a day (pg_net purges responses after hours, so collect follows dispatch closely).
-- anon-exec: revoked (refresh_topshot_subeditions) — called only by pg_cron as postgres; REVOKE below.
-- revert: SELECT cron.unschedule('rpc-topshot-subeditions-refresh'); DROP FUNCTION public.refresh_topshot_subeditions();
--         DROP TABLE public.topshot_subeditions_refresh_state;

CREATE TABLE IF NOT EXISTS public.topshot_subeditions_refresh_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  request_id bigint,
  dispatched_at timestamptz,
  last_collected_at timestamptz
);
ALTER TABLE public.topshot_subeditions_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_subeditions_refresh_state FROM PUBLIC, anon, authenticated;
INSERT INTO public.topshot_subeditions_refresh_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.refresh_topshot_subeditions()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_state public.topshot_subeditions_refresh_state;
  v_resp record;
  v_map jsonb;
  v_chain int := 0; v_inserted int := 0; v_conflicts int := 0;
  v_err text;
  v_req bigint;
  v_script text := replace(encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29

access(all) fun main(): {UInt32: String} {
    let out: {UInt32: String} = {}
    for s in TopShot.getAllSubeditions() {
        out[s.subeditionID] = s.name
    }
    return out
}
$cdc$, 'UTF8'), 'base64'), E'\n', '');
  v_out jsonb;
BEGIN
  SELECT * INTO v_state FROM public.topshot_subeditions_refresh_state WHERE id = 1 FOR UPDATE;

  IF v_state.request_id IS NULL THEN
    v_req := net.http_post(
      url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed',
      body := jsonb_build_object('script', v_script, 'arguments', jsonb_build_array()),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 30000);
    UPDATE public.topshot_subeditions_refresh_state SET request_id = v_req, dispatched_at = now() WHERE id = 1;
    RETURN jsonb_build_object('phase', 'dispatched', 'request_id', v_req);
  END IF;

  SELECT status_code, content, error_msg, timed_out INTO v_resp FROM net._http_response WHERE id = v_state.request_id;
  IF NOT FOUND THEN
    IF v_state.dispatched_at > now() - interval '30 minutes' THEN
      RETURN jsonb_build_object('phase', 'pending', 'request_id', v_state.request_id);
    END IF;
    v_err := 'no response for request ' || v_state.request_id;
  ELSIF v_resp.status_code IS DISTINCT FROM 200 OR v_resp.timed_out THEN
    v_err := format('flow %s: %s %s', coalesce(v_resp.status_code::text, 'no-status'), coalesce(v_resp.error_msg, ''), left(coalesce(v_resp.content, ''), 160));
  ELSE
    BEGIN
      v_map := convert_from(decode(v_resp.content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
      IF v_map->>'type' IS DISTINCT FROM 'Dictionary' OR jsonb_typeof(v_map->'value') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'unexpected JSON-CDC shape: %', left(v_map::text, 160);
      END IF;
      WITH c AS (
        SELECT (x->'key'->>'value')::int AS id, x->'value'->>'value' AS name FROM jsonb_array_elements(v_map->'value') x
      ), ins AS (
        INSERT INTO public.topshot_subeditions (subedition_id, name, verified_at)
        SELECT id, name, now() FROM c WHERE id IS NOT NULL AND name IS NOT NULL
        ON CONFLICT (subedition_id) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM c), (SELECT count(*) FROM ins),
             (SELECT count(*) FROM c JOIN public.topshot_subeditions s ON s.subedition_id = c.id WHERE s.name IS DISTINCT FROM c.name)
        INTO v_chain, v_inserted, v_conflicts;
      IF v_chain = 0 THEN v_err := 'chain returned no subeditions'; END IF;
      IF v_conflicts > 0 THEN v_err := v_conflicts || ' subedition id(s) named differently on chain than in topshot_subeditions'; END IF;
      UPDATE public.topshot_subeditions s SET verified_at = now()
        FROM jsonb_array_elements(v_map->'value') x
       WHERE s.subedition_id = (x->'key'->>'value')::int AND s.name = x->'value'->>'value';
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_err := 'collect failed: ' || SQLERRM;
    END;
  END IF;

  UPDATE public.topshot_subeditions_refresh_state SET request_id = NULL, last_collected_at = now() WHERE id = 1;
  v_out := jsonb_build_object('phase', 'collected', 'request_id', v_state.request_id, 'chain_subeditions', v_chain,
                              'inserted', v_inserted, 'name_conflicts', v_conflicts, 'error', v_err);
  PERFORM public.log_pipeline_run('topshot-subeditions-refresh', v_err IS NULL, v_out);
  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.refresh_topshot_subeditions() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('rpc-topshot-subeditions-refresh', '17,22 3,9,15,21 * * *', 'SELECT public.refresh_topshot_subeditions();');

-- Logged once per collect (4x/day, 6 h apart): silent past ~2 periods or unsuccessful past ~4 is a stopped lane.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES ('topshot-subeditions-refresh', 800, 1600, 'medium',
        'Top Shot subedition list from the chain (TopShot.getAllSubeditions), feeding atlas_editions_drain''s parallel map; a stall means the next new parallel is skipped again (10-28: Animated/Illustrated). Collects at :22 of 03/09/15/21 UTC.', true)
ON CONFLICT (pipeline) DO NOTHING;

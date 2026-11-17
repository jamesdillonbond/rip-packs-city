-- public.cron_heartbeats
-- Lightweight per-pipeline "I was just fired" signal written before any
-- work begins. Lets the pipeline watchlist distinguish "cron-job.org
-- never fired" from "cron fired but the work silently panicked".
-- pipeline_runs remains the source of truth for completion + outcome;
-- this table is a strictly upstream heartbeat.
CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  pipeline       text        PRIMARY KEY,
  last_fired_at  timestamptz NOT NULL DEFAULT now(),
  last_source    text        NULL
);

ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;

-- No public policies — only postgres/service_role writes via the RPC
-- below. Watchlist readers go through dedicated views or the RPC.

CREATE OR REPLACE FUNCTION public.upsert_cron_heartbeat(
  p_pipeline text,
  p_source   text DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_pipeline IS NULL OR length(p_pipeline) = 0 THEN
    RAISE EXCEPTION 'p_pipeline required';
  END IF;

  INSERT INTO public.cron_heartbeats (pipeline, last_fired_at, last_source)
  VALUES (p_pipeline, v_now, p_source)
  ON CONFLICT (pipeline) DO UPDATE
    SET last_fired_at = EXCLUDED.last_fired_at,
        last_source   = EXCLUDED.last_source;

  RETURN v_now;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_cron_heartbeat(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_cron_heartbeat(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_cron_heartbeat(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_cron_heartbeat(text, text) TO postgres, service_role;

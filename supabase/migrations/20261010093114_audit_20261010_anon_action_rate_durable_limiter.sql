-- audit_20261010_anon_action_rate_durable_limiter
--
-- 2026-10-10 (~2:35 AM PT, Claude Code cloud). A DURABLE, cross-instance rate
-- counter for anonymous routes that can trigger expensive or outward work. The
-- only cross-cutting limit today is proxy.ts's per-lambda, in-memory 60/min/IP —
-- a burst spread across N instances gets N× the budget, a cold start empties it,
-- and a fake `sb-*auth-token*` cookie raises it to 240/min. From the 10-10
-- anonymous-write audit: /api/public/queue-wallet dispatches a ~6-lambda
-- multicollection backfill per request with no durable cap; /api/early-access/
-- submit pages the operator on Telegram and auto-approves; /api/subscribe and the
-- magic-link route mail any address. The concierge already has a durable
-- per-IP counter (bump_concierge_ip_rate); this is the same shape, generalised by
-- a `bucket` so each route keeps its own window, and keyed by an opaque string the
-- caller hashes (no raw IPs stored).
--
-- New objects only: table public.anon_action_rate (RLS on, no policies, no anon/
-- authenticated grants) and public.bump_anon_action_rate (SECDEF, service_role +
-- postgres only). Callers FAIL CLOSED on an error.
--
-- anon-exec: bump_anon_action_rate -- revoked below (REVOKE FROM PUBLIC, anon, authenticated; GRANT service_role, postgres).
--
-- Revert: DROP FUNCTION public.bump_anon_action_rate(text, text, integer, integer);
--         DROP TABLE public.anon_action_rate;

CREATE TABLE IF NOT EXISTS public.anon_action_rate (
  bucket       text        NOT NULL,
  key          text        NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key)
);
ALTER TABLE public.anon_action_rate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.anon_action_rate FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bump_anon_action_rate(p_bucket text, p_key text, p_limit integer, p_window_secs integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_bucket IS NULL OR p_key IS NULL OR length(p_bucket) = 0 OR length(p_key) = 0
     OR length(p_bucket) > 64 OR length(p_key) > 128 OR p_limit IS NULL OR p_window_secs IS NULL THEN
    RAISE EXCEPTION 'bump_anon_action_rate: bad arguments';
  END IF;
  INSERT INTO public.anon_action_rate AS r (bucket, key, window_start, count)
  VALUES (p_bucket, p_key, now(), 1)
  ON CONFLICT (bucket, key) DO UPDATE SET
    count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_secs) THEN 1 ELSE r.count + 1 END,
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_secs) THEN now() ELSE r.window_start END
  RETURNING r.count INTO v_count;
  RETURN jsonb_build_object('allowed', v_count <= p_limit, 'count', v_count, 'limit', p_limit);
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_anon_action_rate(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_anon_action_rate(text, text, integer, integer) TO service_role, postgres;

COMMENT ON FUNCTION public.bump_anon_action_rate(text, text, integer, integer) IS
'Durable fixed-window counter for anonymous routes (2026-10-10). One row per (bucket, key); key is a caller-side hash (IP or wallet), or ''*'' for a global cap. Returns {allowed, count, limit}. Callers fail CLOSED on error. See lib/abuse/anon-rate.ts.';

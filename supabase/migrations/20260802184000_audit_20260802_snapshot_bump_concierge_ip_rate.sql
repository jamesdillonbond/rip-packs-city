-- Snapshot migration: public.bump_concierge_ip_rate(text, integer, integer).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The per-IP sliding-window rate limiter guarding the AI concierge (a PAID
-- Anthropic API surface). Each call bumps the IP's counter within the current
-- window and reports allowed = count <= limit; once the window elapses the
-- counter RESETS to 1. A regression that failed to reset lets a legitimate IP get
-- permanently throttled; one that failed to increment lets an abuser run the paid
-- endpoint unbounded. A missing/oversized IP is skipped (fails open).
--
-- Pinned by supabase/tests/bump_concierge_ip_rate.sql.

CREATE OR REPLACE FUNCTION public.bump_concierge_ip_rate(p_ip text, p_limit integer, p_window_secs integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_ip IS NULL OR length(p_ip) = 0 OR length(p_ip) > 100 THEN
    RETURN jsonb_build_object('allowed', true, 'skipped', true);
  END IF;
  INSERT INTO public.concierge_ip_rate AS c (ip, window_start, count)
  VALUES (p_ip, now(), 1)
  ON CONFLICT (ip) DO UPDATE SET
    count = CASE WHEN c.window_start < now() - make_interval(secs => p_window_secs) THEN 1 ELSE c.count + 1 END,
    window_start = CASE WHEN c.window_start < now() - make_interval(secs => p_window_secs) THEN now() ELSE c.window_start END
  RETURNING c.count INTO v_count;
  RETURN jsonb_build_object('allowed', v_count <= p_limit, 'count', v_count);
END;
$function$;

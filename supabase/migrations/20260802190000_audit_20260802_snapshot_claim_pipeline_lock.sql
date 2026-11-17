-- Snapshot migration: public.claim_pipeline_lock(text, integer).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The cross-session concurrency guard that stops a pipeline from running twice at
-- once. A caller claims a lock_key; the claim SUCCEEDS only when the row is new,
-- previously 'done', or STALE (claimed longer ago than p_stale_seconds — the
-- crashed-holder recovery). A fresh in_progress lock is NOT re-claimable, so a
-- second concurrent worker gets false and backs off. A regression that let a
-- fresh lock be re-claimed reintroduces the double-run/data-race this guards; one
-- that failed to break a stale lock wedges the pipeline forever.
--
-- Pinned by supabase/tests/claim_pipeline_lock.sql.

CREATE OR REPLACE FUNCTION public.claim_pipeline_lock(p_key text, p_stale_seconds integer DEFAULT 660)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claimed boolean := false;
BEGIN
  INSERT INTO public.pipeline_run_locks (lock_key, status, claimed_at, released_at, attempts)
  VALUES (p_key, 'in_progress', now(), NULL, 1)
  ON CONFLICT (lock_key) DO UPDATE
     SET status      = 'in_progress',
         claimed_at  = now(),
         released_at = NULL,
         attempts    = public.pipeline_run_locks.attempts + 1
   WHERE public.pipeline_run_locks.status = 'done'
      OR public.pipeline_run_locks.claimed_at < now() - make_interval(secs => p_stale_seconds)
  RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END;
$function$;

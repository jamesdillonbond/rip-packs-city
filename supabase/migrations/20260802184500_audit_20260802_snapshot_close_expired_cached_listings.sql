-- Snapshot migration: public.close_expired_cached_listings().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Sweeps cached_listings_v2 and closes listings whose expiry has passed: only
-- rows that are still open (completed_at IS NULL) with a non-NULL expiry in the
-- past are marked completed_status='expired' at completed_at=LEAST(expiry, now).
-- A regression that closed open/future/NULL-expiry listings would prematurely
-- retire live marketplace listings (or clobber already-closed ones), corrupting
-- the freshness of every sniper/market surface that reads this table.
--
-- Pinned by supabase/tests/close_expired_cached_listings.sql.

CREATE OR REPLACE FUNCTION public.close_expired_cached_listings()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_closed int := 0;
  v_started timestamptz := NOW();
BEGIN
  WITH upd AS (
    UPDATE cached_listings_v2
    SET completed_at = LEAST(expiry_at, NOW()),
        completed_status = 'expired'
    WHERE completed_at IS NULL
      AND expiry_at IS NOT NULL
      AND expiry_at < NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_closed FROM upd;

  RETURN jsonb_build_object(
    'closed', v_closed,
    'duration_ms', EXTRACT(EPOCH FROM (NOW() - v_started)) * 1000,
    'finished_at', NOW()
  );
END;
$function$;

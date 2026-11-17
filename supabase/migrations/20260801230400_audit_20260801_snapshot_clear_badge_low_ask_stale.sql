-- Snapshot migration: public.clear_badge_low_ask_stale(uuid,interval).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: nulls out badge_editions.low_ask rows that have gone stale (older
-- than p_stale_after) for a collection — called from the AllDay listing-cache
-- refresh so a dead ask doesn't linger on a badge. Load-bearing DATA-LOSS
-- SAFEGUARD: it REJECTS a null/non-positive interval (without which a 0/NULL
-- window would match `updated_at < NOW()` for every row and wipe EVERY low_ask);
-- otherwise it clears ONLY rows that match the collection AND have a non-null
-- low_ask AND a non-null updated_at older than the window, and returns the count.

CREATE OR REPLACE FUNCTION public.clear_badge_low_ask_stale(p_collection_id uuid, p_stale_after interval)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  rows_affected integer;
BEGIN
  IF p_stale_after IS NULL OR p_stale_after <= INTERVAL '0 seconds' THEN
    RAISE EXCEPTION 'p_stale_after must be a positive interval, got %', p_stale_after;
  END IF;

  WITH cleared AS (
    UPDATE badge_editions be
    SET low_ask = NULL,
        updated_at = NOW()
    WHERE be.collection_id = p_collection_id
      AND be.low_ask IS NOT NULL
      AND be.updated_at IS NOT NULL
      AND be.updated_at < NOW() - p_stale_after
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM cleared;
  RETURN rows_affected;
END;
$function$;

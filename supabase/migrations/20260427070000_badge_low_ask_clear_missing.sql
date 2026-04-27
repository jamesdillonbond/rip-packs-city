-- Complement to update_badge_low_ask_by_external. After a successful, complete
-- marketplace fetch, set low_ask = NULL for any badge_editions row in the
-- collection whose external_id is NOT in the present set. Without this,
-- editions whose listings get sold or pulled keep their stale low_ask
-- forever — and the IS DISTINCT FROM filter in update_badge_low_ask_by_external
-- never re-clears them because there's no incoming row to compare against.
--
-- Caller MUST only invoke this when the upstream marketplace pagination
-- exited cleanly (hasNextPage=false), i.e. the present set is authoritative.
-- A partial fetch (page-cap hit, network error mid-stream) would
-- incorrectly clear low_ask for editions beyond the truncation point.

CREATE OR REPLACE FUNCTION public.clear_badge_low_ask_missing(
  p_collection_id uuid,
  p_present_external_ids text[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected integer;
BEGIN
  WITH upd AS (
    UPDATE badge_editions be
    SET
      low_ask = NULL,
      updated_at = now()
    WHERE be.collection_id = p_collection_id
      AND be.low_ask IS NOT NULL
      AND NOT (be.external_id = ANY(p_present_external_ids))
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM upd;
  RETURN rows_affected;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_badge_low_ask_missing(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_badge_low_ask_missing(uuid, text[]) TO service_role;

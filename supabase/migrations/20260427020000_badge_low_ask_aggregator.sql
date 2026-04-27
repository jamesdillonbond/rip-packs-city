-- Two helpers for back-filling badge_editions.low_ask. Both are search_path-locked,
-- atomic, and idempotent (only update rows whose low_ask actually changes).
--
-- update_badge_low_ask_by_external: per-edition data → match by external_id.
-- Used by AllDay where the GQL marketplace endpoint returns
-- editionFlowID + lowestPrice for thousands of editions.
--
-- update_badge_low_ask_from_cached_listings: compound match by
-- (player_name, set_name, tier). Used by Golazos until a proper per-edition
-- marketplace endpoint is plumbed; coverage today is partial because
-- cached_listings is a top-N snapshot, not a full marketplace dump.

CREATE OR REPLACE FUNCTION public.update_badge_low_ask_by_external(
  p_collection_id uuid,
  p_data jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected integer;
BEGIN
  WITH src AS (
    SELECT
      (j->>'external_id')::text AS external_id,
      (j->>'low_ask')::numeric AS low_ask
    FROM jsonb_array_elements(p_data) j
    WHERE (j->>'external_id') IS NOT NULL
      AND (j->>'low_ask') IS NOT NULL
  ),
  upd AS (
    UPDATE badge_editions be
    SET
      low_ask = src.low_ask,
      updated_at = now()
    FROM src
    WHERE be.collection_id = p_collection_id
      AND be.external_id = src.external_id
      AND (be.low_ask IS DISTINCT FROM src.low_ask)
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM upd;
  RETURN rows_affected;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_badge_low_ask_from_cached_listings(
  p_collection_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected integer;
BEGIN
  WITH floors AS (
    SELECT
      lower(player_name) AS player_name_lc,
      set_name,
      tier,
      MIN(NULLIF(ask_price, 0)) AS low_ask
    FROM cached_listings
    WHERE collection_id = p_collection_id
      AND ask_price IS NOT NULL AND ask_price > 0
      AND player_name IS NOT NULL
      AND set_name IS NOT NULL
      AND tier IS NOT NULL
    GROUP BY lower(player_name), set_name, tier
  ),
  upd AS (
    UPDATE badge_editions be
    SET
      low_ask = floors.low_ask,
      updated_at = now()
    FROM floors
    WHERE be.collection_id = p_collection_id
      AND lower(be.player_name) = floors.player_name_lc
      AND be.set_name = floors.set_name
      AND be.tier = floors.tier
      AND (be.low_ask IS DISTINCT FROM floors.low_ask)
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM upd;
  RETURN rows_affected;
END;
$$;

REVOKE ALL ON FUNCTION public.update_badge_low_ask_by_external(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_badge_low_ask_from_cached_listings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_badge_low_ask_by_external(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_badge_low_ask_from_cached_listings(uuid) TO service_role;

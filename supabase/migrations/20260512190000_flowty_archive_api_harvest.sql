-- ── flowty_archive schema + api_harvest_20260512 ─────────────────────────────
-- Created for the Flowty data preservation effort (pre-shutdown harvest).
-- Stores raw API responses verbatim so we can mine the archive in SQL later
-- once we know which fields turned out to matter. The dated table name makes
-- it easy to add a 20260612 snapshot table later without colliding.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS flowty_archive;

CREATE TABLE IF NOT EXISTS flowty_archive.api_harvest_20260512 (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  query_params JSONB,
  response_payload JSONB NOT NULL,
  response_status INT,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collection_hint TEXT
);

CREATE INDEX IF NOT EXISTS api_harvest_20260512_endpoint_collected_idx
  ON flowty_archive.api_harvest_20260512 (endpoint, collected_at DESC);

CREATE INDEX IF NOT EXISTS api_harvest_20260512_collection_idx
  ON flowty_archive.api_harvest_20260512 (collection_hint);

ALTER TABLE flowty_archive.api_harvest_20260512 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON flowty_archive.api_harvest_20260512;
CREATE POLICY service_role_all ON flowty_archive.api_harvest_20260512
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Cursor state for the harvester to resume across invocations. Single
-- mutable JSONB blob keyed by harvester id so we can checkpoint progress
-- (last_offset per collection, last_blockTimestamp per Firestore event type,
-- per-NFT cursor, etc.) without inventing a column-per-dimension schema.
CREATE TABLE IF NOT EXISTS flowty_archive.harvest_state (
  id TEXT PRIMARY KEY,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE flowty_archive.harvest_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON flowty_archive.harvest_state;
CREATE POLICY service_role_all ON flowty_archive.harvest_state
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- PostgREST doesn't expose the flowty_archive schema by default. SECURITY
-- DEFINER wrappers in `public` let the JS service-role client write through
-- without flipping the API schema config.

CREATE OR REPLACE FUNCTION public.flowty_archive_insert_batch(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, flowty_archive, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO flowty_archive.api_harvest_20260512
    (endpoint, query_params, response_payload, response_status, collection_hint)
  SELECT
    (r->>'endpoint')::text,
    NULLIF(r->'query_params', 'null'::jsonb),
    COALESCE(r->'response_payload', 'null'::jsonb),
    NULLIF((r->>'response_status')::text, '')::int,
    NULLIF(r->>'collection_hint', '')::text
  FROM jsonb_array_elements(p_rows) AS r;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.flowty_archive_insert_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flowty_archive_insert_batch(jsonb) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.flowty_archive_get_cursor(p_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, flowty_archive, pg_temp
AS $fn$
  SELECT COALESCE(cursor, '{}'::jsonb)
  FROM flowty_archive.harvest_state
  WHERE id = p_id;
$fn$;

REVOKE ALL ON FUNCTION public.flowty_archive_get_cursor(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flowty_archive_get_cursor(text) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.flowty_archive_set_cursor(p_id text, p_cursor jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, flowty_archive, pg_temp
AS $fn$
  INSERT INTO flowty_archive.harvest_state(id, cursor, updated_at)
  VALUES (p_id, p_cursor, NOW())
  ON CONFLICT (id) DO UPDATE
    SET cursor = EXCLUDED.cursor,
        updated_at = NOW();
$fn$;

REVOKE ALL ON FUNCTION public.flowty_archive_set_cursor(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flowty_archive_set_cursor(text, jsonb) TO postgres, service_role;

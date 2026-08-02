-- Snapshot migration: public.stub_editions_from_wmc(text, integer).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Self-heals the editions catalog by creating placeholder rows for edition_keys
-- present in wallet_moments_cache but missing from editions (so downstream
-- enrichment/joins don't drop the wallet's moment). It resolves the collection by
-- slug (returning an error if unknown), inserts only genuinely-missing keys for
-- THAT collection (NULL enrichment fields, filled later), is bounded by p_limit,
-- and is idempotent via ON CONFLICT DO NOTHING.
--
-- Pinned by supabase/tests/stub_editions_from_wmc.sql.

CREATE OR REPLACE FUNCTION public.stub_editions_from_wmc(p_collection_slug text, p_limit integer DEFAULT 1000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id uuid;
  v_inserted int := 0;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH
  missing_keys AS (
    SELECT DISTINCT wmc.edition_key
    FROM wallet_moments_cache wmc
    WHERE wmc.collection_id = v_collection_id
      AND wmc.edition_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM editions e
        WHERE e.collection_id = v_collection_id
          AND e.external_id = wmc.edition_key
      )
    LIMIT p_limit
  ),
  inserted AS (
    INSERT INTO editions (collection_id, external_id, player_name, set_name, tier, circulation_count, created_at, updated_at)
    SELECT
      v_collection_id,
      mk.edition_key,
      NULL,  -- player to be resolved later
      NULL,  -- set_name to be resolved later
      NULL,  -- tier to be resolved later
      NULL,
      NOW(),
      NOW()
    FROM missing_keys mk
    ON CONFLICT (external_id, collection_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  RETURN json_build_object(
    'collection', p_collection_slug,
    'stubs_created', v_inserted
  );
END;
$function$;

-- Snapshot migration: public.pinnacle_upsert_nft_map(text, text, text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Upserts the Pinnacle nft_id → edition_key + owner map. The load-bearing honesty
-- invariant is owner = COALESCE(EXCLUDED.owner, existing): a refresh that arrives
-- with a NULL owner must NEVER null out a previously-known owner (that would drop
-- a real holder off wallet/ownership surfaces). It also reports whether the
-- edition_key is already present in pinnacle_editions so the caller knows a
-- backfill is still required.
--
-- Pinned by supabase/tests/pinnacle_upsert_nft_map.sql.

CREATE OR REPLACE FUNCTION public.pinnacle_upsert_nft_map(p_nft_id text, p_edition_key text, p_owner text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_edition_exists boolean;
BEGIN
  -- Safety: verify edition_key exists in pinnacle_editions before inserting, else backfill_pinnacle_sale_editions() will skip it
  SELECT EXISTS(SELECT 1 FROM pinnacle_editions WHERE id = p_edition_key)
  INTO v_edition_exists;

  INSERT INTO pinnacle_nft_map (nft_id, edition_key, owner, created_at)
  VALUES (p_nft_id, p_edition_key, p_owner, now())
  ON CONFLICT (nft_id) DO UPDATE SET
    edition_key = EXCLUDED.edition_key,
    owner = COALESCE(EXCLUDED.owner, pinnacle_nft_map.owner);

  RETURN json_build_object(
    'nft_id', p_nft_id,
    'edition_key', p_edition_key,
    'edition_exists_in_editions_table', v_edition_exists,
    'backfill_required', true
  );
END;
$function$;

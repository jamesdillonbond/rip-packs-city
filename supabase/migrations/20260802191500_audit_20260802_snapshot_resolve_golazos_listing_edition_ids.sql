-- Snapshot migration: public.resolve_golazos_listing_edition_ids().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Self-heals cached_listings_v2.edition_id for Golazos listings by bridging the
-- listing's flow_id to a sold NFT's edition_id. The load-bearing guard is
-- n_editions = 1: it back-fills ONLY when the nft resolves to exactly ONE
-- distinct edition across sales — an ambiguous (>1) or absent match is left NULL
-- rather than guessed, so a listing is never mislabeled with the wrong edition
-- (which would poison the edition-keyed floor/board that reads it).
--
-- Pinned by supabase/tests/resolve_golazos_listing_edition_ids.sql.

CREATE OR REPLACE FUNCTION public.resolve_golazos_listing_edition_ids()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_coll uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  v_resolved int := 0;
BEGIN
  WITH bridge AS (
    SELECT l.listing_resource_id, b.edition_id, b.n_editions
    FROM public.cached_listings_v2 l
    CROSS JOIN LATERAL (
      SELECT (array_agg(DISTINCT sa.edition_id))[1] AS edition_id,
             count(DISTINCT sa.edition_id)          AS n_editions
      FROM public.sales sa
      WHERE sa.collection_id = v_coll
        AND sa.nft_id = l.flow_id::text
        AND sa.edition_id IS NOT NULL
    ) b
    WHERE l.collection_id = v_coll
      AND l.edition_id IS NULL
  ),
  upd AS (
    UPDATE public.cached_listings_v2 l
       SET edition_id = b.edition_id
      FROM bridge b
     WHERE l.listing_resource_id = b.listing_resource_id
       AND l.collection_id = v_coll
       AND l.edition_id IS NULL
       AND b.n_editions = 1
       AND b.edition_id IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_resolved FROM upd;

  RETURN v_resolved;
END;
$function$;

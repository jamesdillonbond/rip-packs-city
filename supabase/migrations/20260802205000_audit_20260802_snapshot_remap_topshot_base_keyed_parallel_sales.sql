-- Snapshot migration: public.remap_topshot_base_keyed_parallel_sales().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The INVERSE of remap_topshot_parallel_to_base_misattributed: a sale sitting on a
-- BASE edition whose moment is actually a known PARALLEL (topshot_moment_subeditions
-- with subedition_id > 0) is moved onto the matching parallel edition
-- (<base>::<subedition_id>). Guarded so it only touches genuinely base-keyed sales
-- (current external_id has no '::'), only for real parallels (subedition_id > 0),
-- and only when the target parallel edition actually exists. A regression mis-keys
-- parallel sales onto the base and corrupts both editions' FMV.
--
-- Pinned by supabase/tests/remap_topshot_base_keyed_parallel_sales.sql.

CREATE OR REPLACE FUNCTION public.remap_topshot_base_keyed_parallel_sales()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE n integer;
BEGIN
  UPDATE sales s
  SET edition_id = te.id
  FROM topshot_moment_subeditions ms,
       editions be,
       editions te
  WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND ms.nft_id = s.nft_id
    AND ms.subedition_id > 0
    AND be.id = s.edition_id
    AND be.external_id NOT LIKE '%::%'
    AND be.external_id = ms.base_external_id
    AND te.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND te.external_id = be.external_id || '::' || ms.subedition_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$;

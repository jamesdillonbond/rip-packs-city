-- Snapshot migration: public.remap_topshot_parallel_to_base_misattributed().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Part of the TopShot parallel-conflation program: moves a SALE that was
-- misattributed to a PARALLEL edition (external_id '<base>::<sub>') back onto its
-- BASE edition — but ONLY when it is safe to do so. A sale is remapped when the
-- moment is a known base (a subedition_id=0 row), OR when it is NOT a known
-- parallel AND its serial overflows the parallel's circulation while fitting
-- inside the base's (the "serial too high for the parallel" heuristic). The
-- moments feeder is remapped the same way but SKIPS any row that would collide
-- with an existing base (edition_id, serial_number). A regression here mis-keys
-- sales, which corrupts every edition-keyed FMV/price derived from them.
--
-- Pinned by supabase/tests/remap_topshot_parallel_to_base_misattributed.sql.

CREATE OR REPLACE FUNCTION public.remap_topshot_parallel_to_base_misattributed()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  ts_id constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n_sales integer;
BEGIN
  -- 1. Sales (correctness path).
  UPDATE sales s
  SET edition_id = be.id
  FROM editions pe, editions be
  WHERE s.collection_id = ts_id
    AND pe.id = s.edition_id
    AND pe.external_id LIKE '%::%'
    AND be.collection_id = ts_id
    AND be.external_id = split_part(pe.external_id, '::', 1)
    AND (
      EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
              WHERE ms.nft_id = s.nft_id AND ms.subedition_id = 0)
      OR (
        NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
                    WHERE ms.nft_id = s.nft_id AND ms.subedition_id > 0
                      AND pe.external_id = ms.base_external_id || '::' || ms.subedition_id)
        AND pe.circulation_count > 0
        AND s.serial_number > pe.circulation_count
        AND be.circulation_count >= s.serial_number
      )
    );
  GET DIAGNOSTICS n_sales = ROW_COUNT;

  -- 2. Moments feeder cleanup (best-effort; skip any that would collide with an
  --    existing base (edition_id, serial_number) row).
  UPDATE moments m
  SET edition_id = be.id
  FROM editions pe, editions be
  WHERE m.collection_id = ts_id
    AND pe.id = m.edition_id
    AND pe.external_id LIKE '%::%'
    AND be.collection_id = ts_id
    AND be.external_id = split_part(pe.external_id, '::', 1)
    AND NOT EXISTS (SELECT 1 FROM moments m2
                    WHERE m2.edition_id = be.id AND m2.serial_number = m.serial_number)
    AND (
      EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
              WHERE ms.nft_id = m.nft_id AND ms.subedition_id = 0)
      OR (
        NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
                    WHERE ms.nft_id = m.nft_id AND ms.subedition_id > 0
                      AND pe.external_id = ms.base_external_id || '::' || ms.subedition_id)
        AND pe.circulation_count > 0
        AND m.serial_number > pe.circulation_count
        AND be.circulation_count >= m.serial_number
      )
    );

  RETURN n_sales;
END
$function$;

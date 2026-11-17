-- Companion to 20260829202655 (same prod change). The first apply had an
-- OUT-column/table-column ambiguity on `confidence`; this is the corrected
-- definition (table aliased fs, projected column conf). Idempotent; committing
-- both files reproduces the final function and clears migration-parity for both
-- recorded names. Re-running against prod is a no-op.
-- anon-exec: already-revoked — sentinel_fmv_confidence_rows has anon EXECUTE = FALSE
-- and authenticated EXECUTE = FALSE, verified 2026-08-29 via has_function_privilege()
-- rather than acl text. This is a SNAPSHOT migration: CREATE OR REPLACE FUNCTION does not
-- reset a function ACL, so the existing revoke survives and adding a REVOKE here
-- would be a production ACL change, not a no-op. Hence the marker, not a revoke.
CREATE OR REPLACE FUNCTION public.sentinel_fmv_confidence_rows(p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(confidence text, count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Push the collection filter INSIDE the DISTINCT ON so the per-partition
  -- (collection_id, edition_id, computed_at DESC) indexes drive a Merge Append
  -- (Index Only Scan, no external sort). Reading fmv_current instead computed
  -- DISTINCT ON over all 3 partitions BEFORE filtering, which spilled and timed
  -- out in the daytime IO band -- killing rpc_ops_snapshot()'s fmv leg ~half the day.
  -- edition_id -> collection_id is 1:1, so filtering before vs after DISTINCT ON
  -- selects the same latest-per-edition rows. NULL (all) path preserved.
  IF p_collection_id IS NULL THEN
    RETURN QUERY
      SELECT d.conf::text, count(*)::bigint
      FROM (
        SELECT DISTINCT ON (fs.edition_id) fs.confidence AS conf
        FROM public.fmv_snapshots fs
        ORDER BY fs.edition_id, fs.computed_at DESC
      ) d
      GROUP BY d.conf;
  ELSE
    RETURN QUERY
      SELECT d.conf::text, count(*)::bigint
      FROM (
        SELECT DISTINCT ON (fs.edition_id) fs.confidence AS conf
        FROM public.fmv_snapshots fs
        WHERE fs.collection_id = p_collection_id
        ORDER BY fs.edition_id, fs.computed_at DESC
      ) d
      GROUP BY d.conf;
  END IF;
END;
$function$;

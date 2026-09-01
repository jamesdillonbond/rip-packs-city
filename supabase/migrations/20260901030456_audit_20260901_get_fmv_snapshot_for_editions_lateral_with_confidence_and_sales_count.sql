-- audit_20260901_get_fmv_snapshot_for_editions_lateral_with_confidence_and_sales_count
--
-- anon-exec: none for public.get_fmv_snapshot_for_editions(uuid, uuid[]) — this
-- migration CREATEs a NEW function with a NEW signature, so per the "new overload
-- lands with default PUBLIC EXECUTE" rule it is explicitly REVOKEd from PUBLIC,
-- anon and authenticated below and GRANTed only to postgres and service_role.
-- It is NOT SECURITY DEFINER (it runs as the caller, RLS applies).
--
-- WHY
-- `supabase/functions/enrich-ufc-wallet/index.ts:171-189` preloads latest FMV for
-- the whole UFC Strike catalogue in 200-wide slices via PostgREST:
--     .from("fmv_snapshots")
--     .select("edition_id, fmv_usd, confidence, sales_count_30d, computed_at")
--     .in("edition_id", slice).order("computed_at", { ascending: false })
-- Measured in production (pgss queryid 1387451210050502049, 24 h to 2026-09-01
-- 02:45Z): ~185,457 buffers per call, ~29.4 s, hitting the 30 s service_role cap.
-- The plan read out of postgres_logs on a 29.46 s execution is a walk of the
-- ORDERING index `idx_fmv_snapshots_2026_computed_at_desc` with edition_id as a
-- Filter, accumulating toward PostgREST's 1,000-row cap — a slice of ~118-200
-- editions holds only ~1,100 snapshot rows in total, so it can never reach 1,000
-- and walks essentially the whole partition.
--
-- The existing sibling `get_fmv_for_editions(uuid, uuid[])` already has the right
-- shape but returns only (edition_id, fmv_usd). The caller needs `confidence` and
-- `sales_count_30d` for its $10K defensive ceiling (index.ts:196-200), so the
-- straight swap does not typecheck. This function is that sibling plus the two
-- columns; the body is otherwise byte-for-byte the same shape.
--
-- ⭐ The durable property, which is stronger than the buffers ratio: the `LIMIT 1`
-- lives INSIDE the LATERAL, so this can only ever do one index descent per
-- edition_id. The ordering-index walk is not merely out-costed, it is structurally
-- unreachable. Measured on a real 200-edition UFC slice at 2026-09-01 03:1xZ:
-- 1,435 buffers (1,257 hit / 178 read), 134 ms, Index Scan using
-- fmv_snapshots_2026_edition_id_computed_at_conf_idx — and 235 of those buffers
-- are the scratch query that built the id array, which the caller supplies.
--
-- ⚠ NOT YET WIRED. Nothing calls this. The caller change is two lines in
-- enrich-ufc-wallet and cannot be pushed from a cloud pass; it is queued for
-- Claude Code. This migration is inert until then and is safe to sit unused.
--
-- SEMANTICS: identical to get_fmv_for_editions for the columns they share —
-- newest snapshot per edition by computed_at DESC, filtered to p_collection_id,
-- fmv_usd IS NOT NULL. An edition whose newest snapshot has a NULL fmv_usd is
-- omitted, which is what the caller already does with it (`fmvByExt.set(ext, null)`).
--
-- REVERT: DROP FUNCTION IF EXISTS public.get_fmv_snapshot_for_editions(uuid, uuid[]);
--         Nothing depends on it, so the drop is unconditional and complete.

CREATE OR REPLACE FUNCTION public.get_fmv_snapshot_for_editions(
  p_collection_id uuid,
  p_edition_ids uuid[]
)
RETURNS TABLE(
  edition_id uuid,
  fmv_usd numeric,
  confidence public.fmv_confidence,
  sales_count_30d integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '300s'
AS $function$
  SELECT lf.edition_id, lf.fmv_usd, lf.confidence, lf.sales_count_30d
  FROM (SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)) ids
  JOIN LATERAL (
    SELECT fs.edition_id, fs.fmv_usd, fs.confidence, fs.sales_count_30d, fs.collection_id
    FROM fmv_snapshots fs
    WHERE fs.edition_id = ids.id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) lf ON true
  WHERE lf.collection_id = p_collection_id
    AND lf.fmv_usd IS NOT NULL;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_fmv_snapshot_for_editions(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_fmv_snapshot_for_editions(uuid, uuid[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_fmv_snapshot_for_editions(uuid, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_fmv_snapshot_for_editions(uuid, uuid[]) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_fmv_snapshot_for_editions(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.get_fmv_snapshot_for_editions(uuid, uuid[]) IS
  'Latest fmv_snapshots row per edition (computed_at DESC), scoped to p_collection_id, with confidence and sales_count_30d. Sibling of get_fmv_for_editions, which returns only (edition_id, fmv_usd). Exists so enrich-ufc-wallet can stop reading fmv_snapshots through PostgREST, where the planner walks the computed_at ordering index toward the 1,000-row cap (~185k buffers / ~29 s per 200-edition slice, measured 2026-09-01). The LIMIT 1 inside the LATERAL makes that walk structurally unreachable. Added by migration audit_20260901_get_fmv_snapshot_for_editions_lateral_with_confidence_and_sales_count.';
-- fmv-recalc step3_today_purge fails under evening contention with
-- "canceling statement due to lock timeout": the inline PostgREST
-- .from('fmv_snapshots').delete() runs via authenticator, whose ~8s lock_timeout
-- survives SET ROLE and applies to the delete (same class as the 07-11
-- upsert_pack_rips fix). A pooled inline delete has nowhere to raise lock_timeout,
-- so move the today-purge into a SECDEF RPC carrying lock_timeout=25s (brief
-- overlaps wait it out instead of failing). Behavior-identical delete; no pricing
-- logic. service_role only, anon EXECUTE explicitly revoked (default-privileges footgun).
CREATE OR REPLACE FUNCTION public.purge_fmv_snapshots_today(
  p_edition_ids uuid[],
  p_today_start timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '25s'
SET statement_timeout TO '60s'
AS $function$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.fmv_snapshots
  WHERE edition_id = ANY(p_edition_ids)
    AND computed_at >= p_today_start;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today(uuid[], timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today(uuid[], timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today(uuid[], timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_fmv_snapshots_today(uuid[], timestamptz) TO service_role;

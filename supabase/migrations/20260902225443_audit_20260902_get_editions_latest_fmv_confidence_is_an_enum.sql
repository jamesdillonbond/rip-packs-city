-- FIX for audit_20260902_get_editions_latest_fmv_lateral, applied minutes later.
-- `fmv_snapshots.confidence` is the ENUM `fmv_confidence`, not text, so the
-- RETURNS TABLE (... confidence text ...) declaration failed at RUNTIME with
-- 42804 "structure of query does not match function result type" — the CREATE
-- succeeded, the first call did not. plpgsql checks the row type when the query
-- runs, not when the function is defined, so a function like this is not
-- verified by having applied cleanly. Caught on the first invocation.
--
-- text is the right EXTERNAL type here (the concierge JSON-encodes it and the
-- prompt compares it as a string), so the cast belongs in the body rather than
-- the signature — declaring the enum would leak an internal type into the RPC
-- contract and break the next time a variant is added.
--
-- REVERT: DROP FUNCTION public.get_editions_latest_fmv(uuid[]);

CREATE OR REPLACE FUNCTION public.get_editions_latest_fmv(p_edition_ids uuid[])
RETURNS TABLE (
  edition_id  uuid,
  fmv_usd     numeric,
  confidence  text,
  computed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- plpgsql, not LANGUAGE sql: a sql-language function is planned param-blind
  -- and this plan's whole value is the per-id index probe, which a generic
  -- plan can flatten into the same full pass the function exists to avoid.
  RETURN QUERY
  SELECT e.id, s.fmv_usd, s.confidence::text, s.computed_at
  FROM unnest(COALESCE(p_edition_ids, ARRAY[]::uuid[])) AS e(id)
  CROSS JOIN LATERAL (
    SELECT fs.fmv_usd, fs.confidence, fs.computed_at
    FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id
      AND fs.computed_at <= now()
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) s;
END;
$function$;

-- Same signature, so the ACLs from the previous migration survive; re-stated
-- because CREATE OR REPLACE resetting function grants is a documented trap in
-- this repo and being explicit costs nothing.
REVOKE ALL ON FUNCTION public.get_editions_latest_fmv(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_editions_latest_fmv(uuid[]) TO service_role;

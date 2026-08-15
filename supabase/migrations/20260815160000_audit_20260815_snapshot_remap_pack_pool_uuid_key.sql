-- Snapshot migration: public.remap_pack_pool_uuid_key(text, text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-15) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical), so
-- it is committed UNAPPLIED — every apply_migration costs a ~10-20s burst of
-- user-facing PGRST002 500s and this one would buy nothing.
--
-- Part of the TopShot parallel-conflation program, and the only member that
-- DELETES. editions stores the same TopShot moment under two key conventions
-- (int 'setID:playID' and a UUID pair); pack_drop_pool rows written under the
-- UUID key have to be re-pointed at the canonical int-keyed edition. Two writes
-- do that, and the split between them is the whole invariant:
--
--   • UPDATE re-points a row onto the canonical edition, but ONLY where the
--     canonical is NOT already present in that (dist_id, slot_name) — otherwise
--     the re-point would violate the pool's uniqueness.
--   • DELETE removes exactly those skipped rows, i.e. the ones whose canonical
--     twin already exists. Its `EXISTS` clause is what confines the delete to
--     genuine duplicates; without it the statement drops live pool rows, and
--     drop_weight is what every pack-EV surface divides by.
--
-- The `p_int_key !~ '^[0-9]+:[0-9]+$'` gate is a second load-bearing guard: it
-- refuses to remap onto anything that is not an int-keyed edition, so a UUID
-- passed in the target slot returns 0 rather than collapsing the two conventions.
--
-- Pinned by supabase/tests/remap_pack_pool_uuid_key.sql.

CREATE OR REPLACE FUNCTION public.remap_pack_pool_uuid_key(p_uuid_key text, p_int_key text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_canon uuid;
  v_updated int := 0;
  v_deleted int := 0;
BEGIN
  IF p_int_key !~ '^[0-9]+:[0-9]+$' THEN RETURN 0; END IF;

  SELECT id INTO v_canon FROM editions
  WHERE collection_id = v_ts AND external_id = p_int_key LIMIT 1;

  IF v_canon IS NULL THEN
    PERFORM public.seed_topshot_editions(ARRAY[p_int_key]);
    SELECT id INTO v_canon FROM editions
    WHERE collection_id = v_ts AND external_id = p_int_key LIMIT 1;
  END IF;
  IF v_canon IS NULL THEN RETURN 0; END IF;

  UPDATE pack_drop_pool pp
  SET edition_id = v_canon, edition_flow_id = p_int_key
  WHERE pp.collection_id = v_ts
    AND pp.edition_flow_id = p_uuid_key
    AND pp.edition_id <> v_canon
    AND NOT EXISTS (
      SELECT 1 FROM pack_drop_pool x
      WHERE x.collection_id = pp.collection_id AND x.dist_id = pp.dist_id
        AND x.slot_name = pp.slot_name AND x.edition_id = v_canon);
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- collision leftovers (canonical already present in that dist+slot): drop the dupe row
  DELETE FROM pack_drop_pool pp
  WHERE pp.collection_id = v_ts
    AND pp.edition_flow_id = p_uuid_key
    AND pp.edition_id <> v_canon
    AND EXISTS (
      SELECT 1 FROM pack_drop_pool x
      WHERE x.collection_id = pp.collection_id AND x.dist_id = pp.dist_id
        AND x.slot_name = pp.slot_name AND x.edition_id = v_canon);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_updated + v_deleted;
END;
$function$;

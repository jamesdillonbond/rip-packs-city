-- Snapshot migration: public.raise_impossible_parallel_circ().
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: a self-heal for TopShot PARALLEL editions (external_id contains
-- '::', i.e. setID:playID::subID) whose recorded circulation_count is below a
-- serial number that has actually SOLD — an impossible state that under-states
-- scarcity and corrupts FMV / pack-EV. It raises circulation_count up to the max
-- observed sold serial, MONOTONICALLY (raise only, never lower — the
-- `o.new_circ > e.circulation_count` guard), scoped to the TopShot collection,
-- and audits each raise into impossible_parallel_circ_raises.

CREATE OR REPLACE FUNCTION public.raise_impossible_parallel_circ()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_raised int := 0;
BEGIN
  WITH offenders AS (
    SELECT e.id, e.external_id, e.circulation_count AS old_circ,
           max(s.serial_number)::int AS new_circ
    FROM public.editions e
    JOIN public.sales s ON s.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.external_id ~ '::'
      AND e.circulation_count > 0
      AND s.serial_number > e.circulation_count
    GROUP BY e.id, e.external_id, e.circulation_count
  ),
  upd AS (
    UPDATE public.editions e
       SET circulation_count = o.new_circ,
           last_updated_at   = now()
      FROM offenders o
     WHERE e.id = o.id
       AND o.new_circ > e.circulation_count   -- MONOTONIC: raise only
    RETURNING e.id, o.external_id, o.old_circ, o.new_circ
  ),
  aud AS (
    INSERT INTO public.impossible_parallel_circ_raises (edition_id, external_id, old_circ, new_circ)
    SELECT id, external_id, old_circ, new_circ FROM upd
    RETURNING 1
  )
  SELECT count(*) INTO v_raised FROM upd;

  RETURN jsonb_build_object('raised', v_raised, 'at', now());
END;
$function$;

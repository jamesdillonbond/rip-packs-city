-- impossible_parallel_selfheal_audits_only_raises_that_survived
--
-- WHY (register #82, measured 2026-09-11). raise_impossible_parallel_circ() has run
-- 4x/day for months, reported `succeeded / "1 row"` on every pg_cron tick, and written
-- 274 audit rows across 188 editions -- and for 185 of those 188 the UPDATE it issues
-- NEVER LANDS. A BEFORE trigger, trg_topshot_normalize_base_club_circulation, fires on
-- every `editions` write and for a Top Shot PARALLEL does:
--
--     NEW.circulation_count := v_atlas;      -- "Atlas is the only per-printing
--                                            --  authority, in both directions"
--
-- an unconditional overwrite from badge_editions. Proven live and rolled back:
--
--     before=99 | wrote=140 | after_trigger=99 | badge_editions_atlas=99
--
-- ⭐ AND THE TRIGGER IS RIGHT. 99 IS the true circulation of a WNBA `Club Collection`
-- parallel. This function is the wrong actor -- it inflates a CORRECT circulation (the
-- number that drives scarcity and FMV) to accommodate sales mis-keyed onto the parallel.
-- The real repair is remap_topshot_parallel_to_base_misattributed(), which re-keys those
-- sales to the BASE edition and which has no cron job at all.
--
-- ⛔ WHAT THIS MIGRATION DOES AND DOES NOT DO. It does NOT change which editions are
-- attempted, does NOT retire the job, and does NOT touch the trigger. It changes only
-- what the function REPORTS, because the reporting was the lie: the audit row was written
-- from the PRE-TRIGGER CTE value and 'raised' counted UPDATEs ATTEMPTED rather than rows
-- CHANGED, so both the log and the return value told a reader the self-heal was working.
-- 3 editions are currently in a hard 6-hourly loop on this (270:8973::17 logged
-- old_circ = 99 eleven consecutive times), and 168 of 188 claimed raises are not
-- reflected in current data -- a ~9x overstatement.
--
-- HOW: `RETURNING e.circulation_count` sees the BEFORE trigger's rewrite -- verified live
-- in a rolled-back DO block (asked_for=140, RETURNING gave 99). So the function can now
-- tell a raise that SURVIVED from one that was reverted, audit only the survivors, and
-- publish `attempted` / `raised` / `reverted_by_trigger`. In production it will now
-- report raised: 0 on most ticks, which makes #82 VISIBLE instead of hidden.
--
-- anon-exec: unchanged -- raise_impossible_parallel_circ is ALREADY revoked in prod
-- (verified 2026-09-11 with has_function_privilege, not acl text: anon EXECUTE false,
-- authenticated EXECUTE false). CREATE OR REPLACE does not reset a function's ACL, so a
-- REVOKE here would change production while pretending to be a body-only rewrite.
-- (raise_impossible_parallel_circ)
--
-- REVERT: re-apply the body from 20260801160200_audit_20260801_snapshot_raise_impossible_parallel_circ.sql
-- (single v_raised counter, audit every updated row, return {raised, at}).
CREATE OR REPLACE FUNCTION public.raise_impossible_parallel_circ()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_attempted int := 0;
  v_raised    int := 0;
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
    RETURNING e.id, o.external_id, o.old_circ, o.new_circ,
              e.circulation_count AS stored_circ
  ),
  aud AS (
    -- Only a raise that SURVIVED the BEFORE trigger is audited. RETURNING above
    -- reports the row as actually STORED, so stored_circ <> new_circ means the
    -- write was reverted inside the same statement and nothing happened.
    INSERT INTO public.impossible_parallel_circ_raises (edition_id, external_id, old_circ, new_circ)
    SELECT id, external_id, old_circ, new_circ FROM upd
     WHERE stored_circ IS NOT DISTINCT FROM new_circ
    RETURNING 1
  )
  SELECT count(*)::int,
         count(*) FILTER (WHERE stored_circ IS NOT DISTINCT FROM new_circ)::int
    INTO v_attempted, v_raised
  FROM upd;

  RETURN jsonb_build_object(
    'raised',              v_raised,
    'attempted',           v_attempted,
    'reverted_by_trigger', v_attempted - v_raised,
    'at',                  now());
END;
$function$;
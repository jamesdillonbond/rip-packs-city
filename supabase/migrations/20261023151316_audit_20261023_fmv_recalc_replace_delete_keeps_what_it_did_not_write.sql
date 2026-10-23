-- audit_20261023_fmv_recalc_replace_delete_keeps_what_it_did_not_write
--
-- 2026-10-23 (PT, Claude Code cloud; Trevor: "work through anything you can handle that is still
-- unresolved from this thread").
--
-- WHAT. fmv-recalc's Step 3 deleted TODAY's fmv_snapshots rows for every edition in its page BEFORE
-- Step 4 built the new rows — and Step 4 can skip an edition (every sale removed by the grail-spike
-- damper, the single-sale common guard, or a failed insert chunk). A skipped edition then kept
-- neither row: today's row from ANOTHER writer was deleted and readers fell back to an older
-- snapshot. Found 2026-10-23 ~8:05 AM PT: the 2:47 AM PT drain_fmv_cold_tail re-stamp of 185:6539
-- (FMV $193.50 = 0.90 x a $215 ask) was copied into edition_fmv_current at 2:59 AM and was then GONE
-- from fmv_snapshots, whose newest row was the stale 10-20 $225 (above the ask). 2 of 10,244 Top Shot
-- rows written today had vanished this way, and both were exactly those re-stamps.
--
-- FIX (the R123 order the edition-floor route already uses): Step 4 inserts FIRST, collecting the new
-- rows' ids, then this function deletes today's rows ONLY for the editions that were written, MINUS
-- the rows just inserted. An edition the run skipped keeps whatever was stamped for it today.
-- purge_fmv_snapshots_today is unchanged (pinned; other callers may exist) — this is a sibling.
--
-- Same settings as purge_fmv_snapshots_today: SECURITY DEFINER, lock_timeout 25s (the reason the
-- delete left PostgREST on 2026-07-13), statement_timeout 60s.
-- anon-exec: revoked — service_role only (purge_fmv_snapshots_today_except)
--
-- REVERT: revert the fmv-recalc commit (Step 3 purge restored before Step 4), then
--         DROP FUNCTION public.purge_fmv_snapshots_today_except(uuid[], timestamptz, uuid[]);

CREATE OR REPLACE FUNCTION public.purge_fmv_snapshots_today_except(
  p_edition_ids uuid[],
  p_today_start timestamptz,
  p_keep_ids uuid[]
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
    AND computed_at >= p_today_start
    AND NOT (id = ANY(COALESCE(p_keep_ids, '{}'::uuid[])));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today_except(uuid[], timestamptz, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today_except(uuid[], timestamptz, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today_except(uuid[], timestamptz, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_fmv_snapshots_today_except(uuid[], timestamptz, uuid[]) TO service_role;

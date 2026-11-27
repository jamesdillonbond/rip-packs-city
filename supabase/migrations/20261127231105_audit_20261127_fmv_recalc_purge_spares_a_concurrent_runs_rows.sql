-- audit_20261127_fmv_recalc_purge_spares_a_concurrent_runs_rows
--
-- 2026-11-27 ~3:25 PM PT (Cowork cloud; Trevor: "Keep going", after the All Day / Panini offer pulls went live).
--
-- FOUND. Two fmv-recalc runs priced the SAME page at once: the GitHub "RPC Data Pipeline" (schedule :45, shed and
-- fired late at 2:48:03 PM PT) and cron-job.org's "RPC FMV Recalc Force Stale" (:48), both offset 3000, 2:48:07 and
-- 2:48:10 PM PT. Each inserted ~500 rows, then purge_fmv_snapshots_today_except deleted TODAY's rows for those
-- editions MINUS ITS OWN ids — i.e. it deleted the OTHER run's fresh rows, and the other run did the same to it.
-- Result: of ~500 editions both runs wrote, 10 kept a 2:48 PM row; the rest had NO row for today and readers fell
-- back to yesterday's price (edition 1805: newest row 11-26 10:48 AM PT). 9 All Day offer-pull rows went with them
-- (fmv_offer_pull_log holds them; fmv_snapshots does not). The workflow header calls this collision "harmless — the
-- route is idempotent"; that stopped being true when the route moved to insert-then-purge on 2026-10-23
-- (20261023151316), because the purge's keep-list only knows ITS OWN run's ids.
--
-- FIX. A sibling, purge_fmv_snapshots_today_except_before, with one more bound: only rows computed BEFORE
-- p_written_before (the calling run's start) are deleted. A concurrent run's rows are written after this run
-- started, so they survive; this run's own just-written rows are still kept by id; every row from earlier today is
-- still replaced. Two concurrent runs now leave two rows for today (readers take the newest computed_at — the
-- documented outcome of a failed purge), never none. Same-run note: a later step that re-writes an edition step 4
-- wrote leaves both rows (also newest-wins); those steps target editions step 4 skipped, so this is rare.
-- ADDITIVE: purge_fmv_snapshots_today_except is left in place (pinned; once the route change deploys it has no
-- caller — no pg_cron or SQL caller either, checked 2026-11-27). Dropping it is a separate, later decision.
-- Same settings as the sibling: SECURITY DEFINER, lock_timeout 25s, statement_timeout 60s.
-- anon-exec: revoked — service_role only (purge_fmv_snapshots_today_except_before)
--
-- REVERT: revert the route change (by message; it calls the old function again), then
--         DROP FUNCTION public.purge_fmv_snapshots_today_except_before(uuid[], timestamptz, uuid[], timestamptz);

CREATE OR REPLACE FUNCTION public.purge_fmv_snapshots_today_except_before(
  p_edition_ids uuid[],
  p_today_start timestamptz,
  p_keep_ids uuid[],
  p_written_before timestamptz
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
    AND computed_at < p_written_before
    AND NOT (id = ANY(COALESCE(p_keep_ids, '{}'::uuid[])));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today_except_before(uuid[], timestamptz, uuid[], timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today_except_before(uuid[], timestamptz, uuid[], timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.purge_fmv_snapshots_today_except_before(uuid[], timestamptz, uuid[], timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_fmv_snapshots_today_except_before(uuid[], timestamptz, uuid[], timestamptz) TO service_role;

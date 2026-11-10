-- audit_20261110_stuck_wmc_fmv_resync_skips_rows_another_writer_holds
--
-- WHY. `resync_stuck_wmc_fmv()` (pg_cron 617, hourly :33, cron_heavy) failed 6 of 48 runs on
-- 11-08/11-09 with `40P01: deadlock detected` (a 7th was a 57014 timeout). The postgres log names
-- the partner every time we could read it: `reconcile_saved_wallets_wmc_fmv(20)` (pg_cron 446,
-- `6,36 * * * *`) → `reconcile_wmc_fmv_for_wallet` — a second writer of the SAME two columns
-- (`fmv_usd`, `fmv_confidence`) from the SAME source (`edition_fmv_current`). The resync now takes
-- 170 s at p50 (max 573 s), so every run overlaps the :36 reconcile; the resync locks rows in
-- edition order, the reconcile in wallet order, and two multi-row UPDATEs waiting on each other's
-- tuples is a cycle. Each deadlock rolled back the WHOLE run (every collection) — nothing lost,
-- since the next hour re-does it, but the lane read FAILING 1 run in 8.
--
-- FIX. The resync locks the rows it means to change with `FOR UPDATE OF w SKIP LOCKED` first and
-- updates exactly those by primary key. A row another transaction holds is skipped, so this
-- function never WAITS on a wmc tuple — and a process that never waits cannot be in a deadlock
-- cycle. A skipped row is either being written by the reconcile (same value, same source) or is
-- picked up by the next hourly run, which is the lane's existing contract (min_age 6 h).
-- Everything else is byte-for-byte the 20260926023709 body: same `ed` set, same predicate, same
-- per-collection counts, same run log.
--
-- Caller enumeration: pg_cron 617 only (`SELECT public.resync_stuck_wmc_fmv();`); no route, edge
-- function, GHA or vercel.json reference (grep of app/ lib/ supabase/functions/ .github/ 11-10).
--
-- anon-exec: unchanged (resync_stuck_wmc_fmv) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false, cron_heavy=true on 11-10.
--
-- REVERT: re-apply the function body from 20260926023709 (the `upd` CTE joins `ed` directly,
-- without the `tgt` lock step).

CREATE OR REPLACE FUNCTION public.resync_stuck_wmc_fmv(p_min_age interval DEFAULT '06:00:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_coll    uuid;
  v_n       integer;
  v_total   integer := 0;
  v_detail  jsonb := '{}'::jsonb;
  v_ok      boolean := true;
  v_err     text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('resync_stuck_wmc_fmv')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  BEGIN
    FOR v_coll IN SELECT id FROM public.collections ORDER BY id LOOP
      WITH ed AS MATERIALIZED (
        SELECT e.collection_id, e.external_id, l.fmv_usd, l.confidence
          FROM public.edition_fmv_current l
          JOIN public.editions e ON e.id = l.edition_id
         WHERE e.collection_id = v_coll
           AND l.fmv_usd IS NOT NULL
           AND l.computed_at < now() - p_min_age
           AND (SELECT f.fmv_usd FROM public.fmv_snapshots f
                 WHERE f.edition_id = l.edition_id AND f.fmv_usd IS NOT NULL
                 ORDER BY f.computed_at DESC LIMIT 1) = l.fmv_usd
      ),
      -- 2026-11-10: lock first, skipping any row another writer holds — this function never waits
      -- on a wmc tuple, so it cannot close a deadlock cycle with reconcile_saved_wallets_wmc_fmv.
      tgt AS MATERIALIZED (
        SELECT w.id, ed.fmv_usd, ed.confidence
          FROM public.wallet_moments_cache w
          JOIN ed ON w.collection_id = ed.collection_id
                 AND w.edition_key   = ed.external_id
         WHERE (w.fmv_usd IS DISTINCT FROM ed.fmv_usd OR w.fmv_confidence IS DISTINCT FROM ed.confidence)
         FOR UPDATE OF w SKIP LOCKED
      ),
      upd AS (
        UPDATE public.wallet_moments_cache w
           SET fmv_usd = tgt.fmv_usd,
               fmv_confidence = tgt.confidence
          FROM tgt
         WHERE w.id = tgt.id
        RETURNING 1
      )
      SELECT count(*)::int INTO v_n FROM upd;
      v_total := v_total + v_n;
      IF v_n > 0 THEN v_detail := v_detail || jsonb_build_object(v_coll::text, v_n); END IF;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- The whole run rolls back to the block start, so nothing is known to be written.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
    v_total := NULL;
  END;
  PERFORM public.log_pipeline_run('wmc-fmv-stuck-resync', v_started, NULL, v_total, NULL, v_ok, v_err,
                                  NULL, NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'via', CASE WHEN session_user = 'cron_heavy' THEN 'pg_cron' ELSE 'manual:' || session_user END, 'min_age', p_min_age::text,
                                                     'fixed_by_collection', v_detail));
  RETURN jsonb_build_object('fixed', v_total, 'ok', v_ok, 'error', v_err, 'by_collection', v_detail);
END
$function$;

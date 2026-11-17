-- audit_20260925_stuck_wmc_fmv_resync_every_collection
--
-- Generalises #141 (Candy, 20260926020644) to every collection. The event-driven lane
-- refresh_wmc_fmv_changed (job 303) skips an edition whose newest snapshot equals its previous
-- one; once a transition is missed, wallet_moments_cache keeps the wrong value forever. Measured
-- 2026-09-25 ~7:40 PM PT: rows whose edition's CURRENT price is >24 h old yet wmc disagrees —
-- Top Shot 5,292 ($59,513 absolute gap), All Day 3,047 ($114,315), Golazos 165 ($1,697),
-- Candy 0 (hourly resync), UFC 0. Those cannot be lag: the price has not moved for a day.
--
-- FIX: an OUTCOME-based resync. For each collection, every edition whose edition_fmv_current row
-- is older than p_min_age (default 6 h, so it never races job 303's normal propagation) AND whose
-- current price equals its latest fmv_snapshots row (two sources agreeing: 8 of 346 stuck Top
-- Shot editions disagree and are LEFT ALONE) has its wmc holders set to that price + confidence.
-- Driven from edition_fmv_current into idx_wmc_coll_ek_serial_cover: EXPLAIN ANALYZE of the
-- finder, Top Shot 224 ms / 91,737 buffers, All Day 98 ms / 31,029 buffers.
--
-- Logged every run as `wmc-fmv-stuck-resync` (rows_written = rows changed, NULL on failure;
-- extra carries per-collection counts). Hourly at :33 as cron_heavy (:33 had no hourly job).
-- lock_timeout 5 s so it yields to job 303 / the saved-wallet lane instead of waiting on them.
--
-- anon-exec: revoked (resync_stuck_wmc_fmv) — new function; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT: SELECT cron.unschedule('rpc-wmc-fmv-stuck-resync');
--         DROP FUNCTION IF EXISTS public.resync_stuck_wmc_fmv(interval);

CREATE OR REPLACE FUNCTION public.resync_stuck_wmc_fmv(p_min_age interval DEFAULT interval '6 hours')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
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
      upd AS (
        UPDATE public.wallet_moments_cache w
           SET fmv_usd = ed.fmv_usd,
               fmv_confidence = ed.confidence
          FROM ed
         WHERE w.collection_id = ed.collection_id
           AND w.edition_key   = ed.external_id
           AND (w.fmv_usd IS DISTINCT FROM ed.fmv_usd OR w.fmv_confidence IS DISTINCT FROM ed.confidence)
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
                                                     'via', 'pg_cron', 'min_age', p_min_age::text,
                                                     'fixed_by_collection', v_detail));
  RETURN jsonb_build_object('fixed', v_total, 'ok', v_ok, 'error', v_err, 'by_collection', v_detail);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.resync_stuck_wmc_fmv(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resync_stuck_wmc_fmv(interval) TO service_role, cron_heavy;

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-wmc-fmv-stuck-resync',
  '33 * * * *',
  'SELECT public.resync_stuck_wmc_fmv();'
);
RESET ROLE;

DO $$
DECLARE v_sched text; v_user text;
BEGIN
  SELECT schedule, username INTO v_sched, v_user FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync';
  IF v_sched IS DISTINCT FROM '33 * * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user IS DISTINCT FROM 'cron_heavy' THEN RAISE EXCEPTION 'owner is not cron_heavy: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;

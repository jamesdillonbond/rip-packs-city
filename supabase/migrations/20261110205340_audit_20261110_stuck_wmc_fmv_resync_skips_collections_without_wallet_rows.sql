-- audit_20261110_stuck_wmc_fmv_resync_skips_collections_without_wallet_rows
--
-- Claude Code cloud, 2026-11-10 ~12:53 PM PT (DB clock). One change to resync_stuck_wmc_fmv (hourly :33, cron_heavy): the
-- per-collection loop visits only collections that have wallet_moments_cache rows.
--
-- WHY: measured ~12:52 PM PT, the Panini leg alone = 440k buffers / 6.8 s per run (42,549 stable editions, each
-- with a latest-snapshot probe), and panini_blockchain has 0 wallet_moments_cache rows (its holdings live in
-- panini_* tables), so that leg can never update anything. Output-identical by construction: a collection with no
-- wmc rows contributes 0 to every count, and the EXISTS is one index probe per collection.
--
-- Base: the body of 20261110150807 (repo md5 = live prosrc md5 a66f309817131d19cdd8a7802320d4ac, read ~12:52 PM PT
-- immediately before this replace); every other line is unchanged.
--
-- anon-exec: unchanged (resync_stuck_wmc_fmv) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false, cron_heavy=true.
--
-- REVERT: re-apply the CREATE OR REPLACE block of 20261110150807_audit_20261110_stuck_wmc_fmv_resync_skips_rows_another_writer_holds.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.resync_stuck_wmc_fmv(interval)'::regprocedure) <> 'a66f309817131d19cdd8a7802320d4ac' THEN
    RAISE EXCEPTION 'resync_stuck_wmc_fmv changed since it was read (expected md5 a66f3098...); re-derive before replacing';
  END IF;
END $$;

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
    -- 2026-11-10 (afternoon): only collections that HAVE wallet rows. A collection with none (Panini: its holdings
    -- live in panini_* tables) cannot produce an update, but its pass still probed the latest snapshot of every
    -- stable edition: 42,549 Panini probes, ~440k buffers / 6.8 s, every hour, for 0 rows by construction.
    FOR v_coll IN SELECT c.id FROM public.collections c
                   WHERE EXISTS (SELECT 1 FROM public.wallet_moments_cache w WHERE w.collection_id = c.id)
                   ORDER BY c.id LOOP
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

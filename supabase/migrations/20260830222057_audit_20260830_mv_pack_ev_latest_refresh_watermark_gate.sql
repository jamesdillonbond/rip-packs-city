-- audit_20260830_mv_pack_ev_latest_refresh_watermark_gate
-- anon-exec: refresh_mv_pack_ev_latest — pre-existing hardened ACL (anon=false, authenticated=false, cron_heavy=true, measured 2026-08-30); CREATE OR REPLACE preserves it, this migration changes only the function body.
--
-- WHY: `refresh_mv_pack_ev_latest()` (pg_cron jobid 73, `3,33 * * * *`, cron_heavy) was the largest consumer in the
-- pack-ev class: 810 calls / 70,017 ms mean / 68.6 GB shared reads since the 08-12 stats reset — to maintain a 768 kB,
-- 1,855-row materialized view. Two independent causes, both measured 2026-08-30:
--   1. pack_ev_history (176 MB, append-only: n_tup_upd=0, n_tup_del=0) had NEVER been vacuumed, so the covering-index
--      scan did 94,595 heap fetches (visibility map unset). A manual VACUUM (ANALYZE) dropped the probe from 2,517 ms /
--      101k buffers to 146 ms / 8.6k buffers. The autovacuum insert threshold (1000 + 0.2 * 300k = ~61k rows) fires
--      only every ~19 days at ~3.2k inserts/day - hence the storage-parameter change below.
--   2. Snapshots land HOURLY (23 distinct hours in the last 24h) while the refresh runs every 30 minutes, so ~half of
--      all refreshes recompute an identical view. CONCURRENTLY still pays the full query + diff both times.
--
-- WHAT: a single-row state table + a watermark gate in the function: skip the REFRESH when pack_ev_history's
-- max(snapshotted_at) (an ~1 ms index probe) has not advanced past the value seen at the last refresh. The watermark is
-- stored OUTSIDE the MV so rows that the MV's WHERE clause filters out (e.g. 'Holding %' packs) still advance it -
-- gating on max(snapshotted_at) FROM the MV itself would re-refresh forever once the newest snapshot batch is all
-- filtered. Fail-open: a missing state row, or a NULL history max, refreshes exactly as before.
--
-- ⚠ SOUNDNESS BOUNDARY: the gate assumes pack_ev_history is append-only (measured: zero updates/deletes since 08-12).
-- An UPDATE or DELETE that does not advance max(snapshotted_at) would leave the MV stale until the next insert.
-- Falsifier: pg_stat_user_tables.n_tup_upd/n_tup_del > 0 for pack_ev_history means this assumption broke - drop the
-- gate (revert below), do not widen it.
--
-- REVERT: CREATE OR REPLACE FUNCTION public.refresh_mv_pack_ev_latest() ... BEGIN REFRESH MATERIALIZED VIEW
--         CONCURRENTLY public.mv_pack_ev_latest; END; (the pre-2026-08-30 one-liner body);
--         DROP TABLE public.mv_pack_ev_latest_refresh_state;
--         ALTER TABLE public.pack_ev_history RESET (autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);

CREATE TABLE IF NOT EXISTS public.mv_pack_ev_latest_refresh_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_seen_snapshot timestamptz,
  refreshed_at timestamptz,
  refreshed_count bigint NOT NULL DEFAULT 0,
  skipped_count bigint NOT NULL DEFAULT 0
);
INSERT INTO public.mv_pack_ev_latest_refresh_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
REVOKE ALL ON public.mv_pack_ev_latest_refresh_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_pack_ev_latest_refresh_state TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_pack_ev_latest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_hist_max timestamptz;
  v_seen timestamptz;
BEGIN
  -- ~1 ms via idx_pack_ev_history_snapshotted_at_desc
  SELECT max(snapshotted_at) INTO v_hist_max FROM public.pack_ev_history;
  SELECT last_seen_snapshot INTO v_seen FROM public.mv_pack_ev_latest_refresh_state WHERE id;
  IF v_hist_max IS NOT NULL AND v_seen IS NOT NULL AND v_hist_max <= v_seen THEN
    -- Nothing new since the last refresh: snapshots land hourly, this job runs
    -- every 30 minutes, so ~half of all ticks take this branch.
    UPDATE public.mv_pack_ev_latest_refresh_state SET skipped_count = skipped_count + 1 WHERE id;
    RETURN;
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_pack_ev_latest;
  UPDATE public.mv_pack_ev_latest_refresh_state
     SET last_seen_snapshot = v_hist_max, refreshed_at = now(), refreshed_count = refreshed_count + 1
   WHERE id;
END;
$function$;

-- Keep the visibility map fresh on this insert-only table: default threshold (1000 + 0.2 * n) fires every ~19 days;
-- 5000 flat fires roughly every day and a half at the measured ~3.2k inserts/day.
ALTER TABLE public.pack_ev_history SET (autovacuum_vacuum_insert_threshold = 5000, autovacuum_vacuum_insert_scale_factor = 0.0);

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 73 AND active AND command LIKE '%refresh_mv_pack_ev_latest%') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: jobid 73 no longer calls refresh_mv_pack_ev_latest';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.mv_pack_ev_latest_refresh_state WHERE id) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: state row missing';
  END IF;
END
$mig$;

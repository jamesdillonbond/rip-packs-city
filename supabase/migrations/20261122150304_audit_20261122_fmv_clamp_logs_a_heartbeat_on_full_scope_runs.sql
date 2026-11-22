-- audit_20261122_fmv_clamp_logs_a_heartbeat_on_full_scope_runs
--
-- 2026-11-22 ~7:15 AM PT (Claude Code cloud; Trevor: "Keep going and working through this").
-- The 11-22 overnight pass found `fmv-clamp-disconnected-ask` reported STALLED (no_marker, silent 4,331 min)
-- while pg_cron job 69 (`55 8 * * *`, `SELECT public.fmv_clamp_disconnected_ask(NULL, false)`) had succeeded
-- every day: the function logs only `IF v_clamped > 0`, and 11-20..11-22 clamped nothing.
-- WHAT: a full-scope (p_collection_id NULL, not dry-run) run always logs one row; a scoped no-op stays silent;
-- rows_found / rows_written now carry the clamp count (never set before). Clamp logic unchanged.
-- Base = live body md5 fb2a2353b971d950d1a00c00c4307d73 (= 20261004002116's), asserted below.
-- anon-exec: unchanged (fmv_clamp_disconnected_ask) -- CREATE OR REPLACE of an existing fn; ACL preserved.
-- REVERT: re-apply the fmv_clamp_disconnected_ask block of
--   supabase/migrations/20261004002116_audit_20261003_fmv_readers_exclude_buyback_wallets.sql.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_clamp_disconnected_ask(uuid,boolean)'::regprocedure)
     <> 'fb2a2353b971d950d1a00c00c4307d73' THEN
    RAISE EXCEPTION 'fmv_clamp_disconnected_ask live body drifted from the 20261004002116 base; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask(p_collection_id uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  c_pinnacle uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ids uuid[];
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  -- Resolve the collection scope into an ARRAY so every downstream predicate can
  -- stay an index condition. Pinnacle never participates: its FMV is render-keyed
  -- in pinnacle_fmv_history, so a median taken from fmv_snapshots would be wrong.
  IF p_collection_id IS NOT NULL THEN
    IF p_collection_id = c_pinnacle THEN
      RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
      RETURN;
    END IF;
    v_ids := ARRAY[p_collection_id];
  ELSE
    SELECT array_agg(c.id) INTO v_ids FROM public.collections c WHERE c.id <> c_pinnacle;
  END IF;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  IF p_dry_run THEN
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = ANY(v_ids)
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales_market s
      WHERE s.collection_id = ANY(v_ids) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = ANY(v_ids)
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales_market s
      WHERE s.collection_id = ANY(v_ids) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    ),
    upd AS (
      UPDATE public.fmv_snapshots fs
      SET fmv_usd = t.new_fmv,
          algo_version = CASE WHEN RIGHT(COALESCE(fs.algo_version,''),9) = '_p90clamp'
                              THEN fs.algo_version
                              ELSE COALESCE(fs.algo_version,'') || '_p90clamp' END
      FROM targets t
      WHERE fs.id = t.snapshot_id
      RETURNING (t.old_fmv - t.new_fmv) AS delta
    )
    SELECT count(*), COALESCE(sum(delta), 0) INTO v_clamped, v_dollars FROM upd;
    v_examined := v_clamped;

    -- 2026-11-22: a FULL-scope run (the daily pg_cron job 69) now logs every time, so the
    -- unwatched-pipeline arm sees a heartbeat on days nothing needed clamping (it read the lane
    -- "silent 4331 min" on 11-22 while job 69 had succeeded daily -- 3 no-op days in a row).
    -- A scoped no-op stays silent, as before. rows_written now carries the clamp count
    -- (it was never set, so clamping days read 0 written in pipeline_runs_daily).
    IF v_clamped > 0 OR p_collection_id IS NULL THEN
      INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, rows_found, rows_written, extra)
      VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true, v_clamped, v_clamped,
              jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2),
                                 'scope', COALESCE(p_collection_id::text, 'all')));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

-- P1b (model root-cause): snap LOW/ASK_ONLY Top Shot FMVs that are disconnected
-- from active recent trading down to recent-market reality. These are stale/troll
-- ASK values (e.g. a role-player common that pumped to $50 3 months ago and now
-- trades at $0.30 still carries FMV $42.50 via the _haircut/cold-tail path; Giannis
-- 8:62 showed $2924 ASK_ONLY vs a $2 p90). They render as fake -98/-99% "deals".
--
-- Anchor = p90 of non-gift (>$0.10) 90d sales (robust to the lone outlier that
-- pollutes max). Clamp to GREATEST(p90*1.5, median). Tiered gate (verified live
-- 2026-07-02: 107 TS editions, 0 legit grails, 0 HIGH/MED touched):
--   * high-circ common (circ>=1000): fmv > 3x p90, OR
--   * any edition:                   fmv > 8x p90  (egregious troll ask).
-- HIGH/MEDIUM (confident sales-based) prices are NEVER touched. Idempotent.
-- Keep the tiered rule in sync with refresh_topshot_fmv_display_guard() +
-- lib/fmv-display-guard.ts.
--
-- Runs once on apply + daily via pg_cron 'rpc-fmv-clamp-disconnected-ask' (55 13 * * *).
-- REVERT: DROP FUNCTION public.fmv_clamp_disconnected_ask_topshot(boolean);
--         SELECT cron.unschedule('rpc-fmv-clamp-disconnected-ask');
--         (clamped fmv_snapshots rows carry algo_version '..._p90clamp'; the prior
--          value is not stored — a fmv-recalc sweep reprices them from sales.)
CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask_topshot(p_dry_run boolean DEFAULT false)
RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  c_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_dry_run THEN
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = c_ts
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = c_ts AND s.sold_at >= now() - interval '90 days'
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
        AND ( (COALESCE(e.circulation_count,0) >= 1000 AND l.fmv_usd > s.p90 * 3)
              OR (l.fmv_usd > s.p90 * 8) )
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = c_ts
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = c_ts AND s.sold_at >= now() - interval '90 days'
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
        AND ( (COALESCE(e.circulation_count,0) >= 1000 AND l.fmv_usd > s.p90 * 3)
              OR (l.fmv_usd > s.p90 * 8) )
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

    INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
    VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
            jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2)));
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

REVOKE ALL ON FUNCTION public.fmv_clamp_disconnected_ask_topshot(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_clamp_disconnected_ask_topshot(boolean) TO service_role, postgres;

-- Daily durability (applied out-of-band via cron.schedule; recorded here):
-- SELECT cron.schedule('rpc-fmv-clamp-disconnected-ask', '55 13 * * *',
--   $$SELECT public.fmv_clamp_disconnected_ask_topshot(false);$$);

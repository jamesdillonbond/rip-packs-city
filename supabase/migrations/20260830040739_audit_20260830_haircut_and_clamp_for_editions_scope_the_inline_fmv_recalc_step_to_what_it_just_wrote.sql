-- audit_20260830_haircut_and_clamp_for_editions_scope_the_inline_fmv_recalc_step_to_what_it_just_wrote
--
-- SATURATION FINDING (pg_stat_statements delta, 03:50-04:01Z, a quiet hour, joined on
-- (userid, dbid, toplevel, queryid)): the instance ran 1,468 s of statement time in 690 s
-- (2.1 concurrent), 550k disk reads, 12.7M buffer hits — 1,386 s of it as service_role, i.e.
-- pipelines, not users. The top two statements by time AND by disk reads were
--     fmv_apply_thin_sale_haircut   3 calls x 38 s   44k reads   2.6M hits
--     fmv_clamp_disconnected_ask    2 calls x 56 s   39k reads   1.3M hits
-- Lifetime since 08-12: 4,870 and 2,680 calls, 754k and 789k buffers/call. They are called
-- INLINE by /api/fmv-recalc (Step 8/9) once per collection that had sales, and fmv-recalc
-- runs every ~10 min (two 20-min schedulers interleave: :08/:28/:48 and :15/:35/:55). Each
-- call does a DISTINCT ON over EVERY snapshot of the collection (twice for the haircut:
-- count + update) and, for the clamp, a 90-day sales aggregate over EVERY edition of the
-- collection — to touch the ~130 rows the recalc just wrote. Roughly a quarter of all DB
-- time in the window, on a 512 MB shared_buffers instance where IO waits (DataFileRead) are
-- what every other statement queues behind.
--
-- The design intent (route comment): "newly-computed ASK-only FMVs get haircut on the same run
-- instead of drifting back to floor between recalcs". The daily full-scope jobs
-- (cron-job.org RPC Apply FMV Haircut 15:35 PT; pg_cron jobid 69 fmv_clamp_disconnected_ask
-- 08:55Z) keep the catch-all semantics. So: two NEW functions that apply the IDENTICAL rules
-- to an explicit edition list, for the inline step only. The pinned two-argument functions
-- (supabase/tests/fmv_apply_thin_sale_haircut.sql, fmv_clamp_disconnected_ask.sql) are
-- untouched; the daily jobs keep calling them.
--
-- SEMANTICS per edition are identical: `latest` = that edition's newest snapshot (LATERAL
-- LIMIT 1 instead of DISTINCT ON), the candidate predicates and multipliers are copied
-- verbatim; the clamp's s90 is GROUP BY edition, so restricting the edition set changes no
-- value. The clamp still skips Pinnacle editions and still logs its pipeline_runs row.
-- Route change (app/api/fmv-recalc/route.ts, same commit): the inline step passes the
-- edition ids it just recalculated; when the map is empty it does nothing (the daily jobs
-- cover the full scope), instead of the old NULL = all-collections fallback.
--
-- MEASURED (dry-run on All Day, under the same IO contention): DISTINCT ON latest over the
-- collection timed out at 58 s; the per-edition LATERAL over all 6,190 All Day editions was
-- 38,621 buffers / 15.9 s; a 500-edition list is ~3k buffers.
--
-- REVERT: DROP FUNCTION public.fmv_apply_thin_sale_haircut_for_editions(uuid[], boolean);
--         DROP FUNCTION public.fmv_clamp_disconnected_ask_for_editions(uuid[], boolean);
--         and revert the route commit (it falls back to the two-argument functions).

CREATE OR REPLACE FUNCTION public.fmv_apply_thin_sale_haircut_for_editions(p_edition_ids uuid[], p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_haircut bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_examined bigint := 0;
  v_haircut  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_edition_ids IS NULL OR cardinality(p_edition_ids) = 0 THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  WITH ids AS (SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)),
  latest AS (
    SELECT lf.*
    FROM ids
    JOIN LATERAL (
      SELECT fs.* FROM fmv_snapshots fs
      WHERE fs.edition_id = ids.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
  ),
  candidates AS (
    SELECT
      l.id AS snapshot_id,
      l.fmv_usd AS old_fmv,
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65
        ELSE 0.55
      END AS haircut
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  to_apply AS (
    SELECT *, ROUND(old_fmv * haircut, 2) AS new_fmv FROM candidates WHERE haircut < 1.0
  )
  SELECT
    (SELECT COUNT(*) FROM candidates),
    (SELECT COUNT(*) FROM to_apply),
    (SELECT COALESCE(SUM(old_fmv - new_fmv), 0) FROM to_apply)
  INTO v_examined, v_haircut, v_dollars;

  IF NOT p_dry_run THEN
    WITH ids AS (SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)),
    latest AS (
      SELECT lf.id
      FROM ids
      JOIN LATERAL (
        SELECT fs.id FROM fmv_snapshots fs
        WHERE fs.edition_id = ids.id
        ORDER BY fs.computed_at DESC
        LIMIT 1
      ) lf ON true
    )
    UPDATE fmv_snapshots fs
    SET fmv_usd = ROUND(fs.fmv_usd *
      CASE
        WHEN COALESCE(fs.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(fs.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(fs.listing_count, 0)  >= 2 THEN 0.65
        ELSE 0.55
      END, 2),
      algo_version = fs.algo_version || '_haircut'
    FROM latest l
    WHERE fs.id = l.id
      AND fs.fmv_usd IS NOT NULL
      AND fs.floor_price_usd IS NOT NULL
      AND COALESCE(fs.sales_count_30d, 0) <= 2
      AND ABS(fs.fmv_usd - fs.floor_price_usd) < 0.01
      AND fs.confidence IN ('LOW','ASK_ONLY');
  END IF;

  RETURN QUERY SELECT v_examined, v_haircut, v_dollars;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask_for_editions(p_edition_ids uuid[], p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  c_pinnacle uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_edition_ids IS NULL OR cardinality(p_edition_ids) = 0 THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  IF p_dry_run THEN
    WITH ids AS (
      SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)
      JOIN public.editions e ON e.id = u.id AND e.collection_id <> c_pinnacle
    ),
    latest AS (
      SELECT lf.id, lf.edition_id, lf.fmv_usd, lf.confidence
      FROM ids
      JOIN LATERAL (
        SELECT fs.id, fs.edition_id, fs.fmv_usd, fs.confidence FROM public.fmv_snapshots fs
        WHERE fs.edition_id = ids.id ORDER BY fs.computed_at DESC LIMIT 1
      ) lf ON true
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.edition_id = ANY(ARRAY(SELECT id FROM ids)) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH ids AS (
      SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)
      JOIN public.editions e ON e.id = u.id AND e.collection_id <> c_pinnacle
    ),
    latest AS (
      SELECT lf.id, lf.edition_id, lf.fmv_usd, lf.confidence
      FROM ids
      JOIN LATERAL (
        SELECT fs.id, fs.edition_id, fs.fmv_usd, fs.confidence FROM public.fmv_snapshots fs
        WHERE fs.edition_id = ids.id ORDER BY fs.computed_at DESC LIMIT 1
      ) lf ON true
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.edition_id = ANY(ARRAY(SELECT id FROM ids)) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
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

    IF v_clamped > 0 THEN
      INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
      VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
              jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2),
                                 'scope', 'editions:' || cardinality(p_edition_ids)));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

-- anon-exec: NOT granted — write functions; service_role only, like their two-argument parents (fmv_apply_thin_sale_haircut_for_editions, fmv_clamp_disconnected_ask_for_editions).
REVOKE ALL ON FUNCTION public.fmv_apply_thin_sale_haircut_for_editions(uuid[], boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fmv_clamp_disconnected_ask_for_editions(uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_apply_thin_sale_haircut_for_editions(uuid[], boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fmv_clamp_disconnected_ask_for_editions(uuid[], boolean) TO service_role;

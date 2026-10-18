-- APPLIED 2026-10-17 5:07 PM PT through the Supabase SQL editor (Trevor's go-ahead in chat 4:46 and 5:05 PM PT); the MCP holds
-- TRUNCATE-bearing bodies. schema_migrations row inserted by hand under this version. Verified: live md5(prosrc)
-- b41a6dfac84b76b53d278008dbf99833, compute-before-TRUNCATE true, anon/authenticated EXECUTE false; one production call wrote
-- 691 rows (688 before, from the 1:45 AM run), every external_id unique.
--
-- 2026-10-17 (Cowork cloud). refresh_topshot_fmv_display_guard: compute the rows BEFORE the TRUNCATE.
--
-- WHY. pg_cron job 68 (`45 8 * * *`, 1:45 AM PT) TRUNCATEs topshot_fmv_display_guard (ACCESS EXCLUSIVE, held to COMMIT) and then
-- builds for 17-25 s (10-12 -> 10-17: 20.0, 21.3, 17.0, 21.2, 23.0, 24.8 s). lib/fmv-display-guard.ts reads the table for /api/market,
-- /api/sniper-feed and the checklists behind an apiReadTimeoutMs race; a warm instance serves its cached map, but a COLD instance whose
-- read times out serves an EMPTY guard — fail-open, i.e. disconnected FMVs shown unclamped — for that request.
-- Found by a pg_proc sweep for "TRUNCATE before the build" after the thin-FMV guard case (8 functions TRUNCATE; only these two do it
-- first on a public-read table; the cross-collection pair truncate after computing, the rest truncate session temp tables).
--
-- HOW. The same CTE chain fills a topshot_fmv_display_guard[] array (column order verified identical to the table and the INSERT list);
-- then TRUNCATE + INSERT FROM unnest(array). Output identical.
-- PRECONDITION: md5(prosrc) = c8114da73398e974641e89ba51e9b882 (the 20261004002116 body). Guarded below.
-- PIN: supabase/tests/refresh_topshot_fmv_display_guard.sql — passes all
-- existing assertions + the new ordering assertion on local Postgres 16; the ordering assertion FAILS on a planted truncate-first body.
-- REVERT: re-apply the refresh_topshot_fmv_display_guard body of 20261004002116.
-- anon-exec: unchanged (refresh_topshot_fmv_display_guard) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false and authenticated=false via has_function_privilege 10-17.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.refresh_topshot_fmv_display_guard()'::regprocedure;
  IF v_md5 <> 'c8114da73398e974641e89ba51e9b882' THEN
    RAISE EXCEPTION 'refresh_topshot_fmv_display_guard changed since base c8114da7 (live md5 %) -- re-derive', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_fmv_display_guard()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_count integer;
  v_rows  public.topshot_fmv_display_guard[];
BEGIN
  -- 2026-10-17: COMPUTE FIRST, then swap. TRUNCATE takes ACCESS EXCLUSIVE and holds it to
  -- COMMIT; with the ~20-25 s build below inside that window, every reader of this table
  -- (lib/fmv-display-guard.ts on /api/market, /api/sniper-feed, checklists) waited out the
  -- build, and a cold instance whose read timed out served NO guard (fail-open = unclamped FMVs).
  -- The rows are built into an array with no lock held; the lock now covers only the insert.
  WITH s90 AS (
    SELECT s.edition_id,
           count(*)::integer AS n_90d,
           max(s.price_usd)::numeric AS max_sale_90d,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd))::numeric AS median_90d,
           count(*) FILTER (WHERE s.price_usd > 0.10)::integer AS n_real,
           (percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS p90_real,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS med_real
    FROM public.sales_market s
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
    GROUP BY s.edition_id
  ),
  lf AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd::numeric AS fmv_usd, fs.confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND fs.computed_at > now() - interval '10 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  scored AS (
    SELECT e.external_id,
           e.id AS edition_id,
           lf.fmv_usd,
           s.max_sale_90d,
           s.median_90d,
           s.n_90d,
           s.p90_real,
           s.med_real,
           (s.n_90d < 15 AND s.median_90d > 0 AND lf.fmv_usd > 1.5 * s.median_90d) AS is_thin,
           (lf.fmv_usd > s.max_sale_90d) AS fmv_exceeds_max,
           (lf.confidence IN ('LOW','ASK_ONLY') AND s.n_real >= 5 AND s.p90_real > 0
             AND ( (COALESCE(e.circulation_count,0) >= 1000 AND lf.fmv_usd > s.p90_real * 3)
                   OR (lf.fmv_usd > s.p90_real * 8) )) AS fmv_disconnected
    FROM public.editions e
    JOIN s90 s ON s.edition_id = e.id
    JOIN lf   ON lf.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id ~ '^[0-9]+:[0-9]+$'
      AND lf.fmv_usd > 0
  )
  SELECT coalesce(array_agg(ROW(external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
         is_thin, fmv_exceeds_max, now(), p90_real, fmv_disconnected,
         CASE WHEN fmv_disconnected
              THEN ROUND(GREATEST(p90_real * 1.5, med_real)::numeric, 2)
              ELSE NULL END)::public.topshot_fmv_display_guard), '{}')
    INTO v_rows
  FROM scored
  WHERE fmv_exceeds_max OR is_thin OR fmv_disconnected;

  TRUNCATE public.topshot_fmv_display_guard;

  INSERT INTO public.topshot_fmv_display_guard
    (external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
     is_thin, fmv_exceeds_max, computed_at, p90_90d, fmv_disconnected, clamp_target)
  SELECT r.external_id, r.edition_id, r.fmv_usd, r.max_sale_90d, r.median_90d, r.n_90d,
         r.is_thin, r.fmv_exceeds_max, r.computed_at, r.p90_90d, r.fmv_disconnected, r.clamp_target
  FROM unnest(v_rows) AS r;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

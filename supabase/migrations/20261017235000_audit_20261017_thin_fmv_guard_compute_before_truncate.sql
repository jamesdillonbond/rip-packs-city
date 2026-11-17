-- APPLIED 2026-10-17 4:50 PM PT through the Supabase SQL editor (Trevor's go-ahead in chat, 4:46 PM PT); the MCP held it
-- (apply_migration returned {"status":"cancelled"} 10-17 ~3:06 PM PT because the body carries the existing TRUNCATE).
-- schema_migrations row inserted by hand under this version. Verified: live md5(prosrc) 9dbaa0117db8a2c0d896c44546e0fe49,
-- compute-before-TRUNCATE true, anon/authenticated EXECUTE false; one production call wrote 16 rows, the same edition set as before.
--
-- 2026-10-17 (Cowork cloud). refresh_topshot_thin_fmv_editions: compute the rows BEFORE the TRUNCATE.
--
-- WHY. TRUNCATE takes ACCESS EXCLUSIVE on topshot_thin_fmv_editions and holds it to COMMIT. The current body truncates FIRST and then
-- runs the ~12 s median scan, so every reader of the table waits out the whole build. topshot_deals_vs_fmv reads it, and
-- get_edition_insight_links (deal_pct leg) reads that view on EVERY edition page. Measured: pg_cron job 63 ran 1:30:00 -> 1:30:12 AM PT
-- 10-17; Postgres logged 9 "canceling statement due to statement timeout" 1:30:08 -> 1:30:12; Vercel's top 48 h error group is
-- "[edition] insight_links canceling statement due to statement timeout" (9 hits, 5 users, last 1:30:04 AM PT). Outside that window the
-- RPC averages 59 ms (352k calls). The route /api/cron/refresh-conflated-editions also calls this function daily (same lock).
--
-- HOW. The same SELECT fills a topshot_thin_fmv_editions[] array with no lock held; then TRUNCATE + INSERT FROM unnest(array). Output
-- is identical (same predicates, same columns; ~16 rows). The lock window shrinks from the scan (~12 s) to the insert (ms).
-- PRECONDITION: md5(prosrc) = 22cec8a2e661a3da6a5f199123b0a24f (the 20261004002116 body). Guarded below.
-- PIN: supabase/tests/refresh_topshot_thin_fmv_editions.sql; it passes all
-- 11 assertions on a local Postgres 16, and its new assertion (5: compute before TRUNCATE) FAILS on a planted truncate-first body.
-- REVERT: re-apply the refresh_topshot_thin_fmv_editions body of 20261004002116.
-- anon-exec: unchanged (refresh_topshot_thin_fmv_editions) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false and authenticated=false via has_function_privilege 10-17.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.refresh_topshot_thin_fmv_editions()'::regprocedure;
  IF v_md5 <> '22cec8a2e661a3da6a5f199123b0a24f' THEN
    RAISE EXCEPTION 'refresh_topshot_thin_fmv_editions changed since base 22cec8a2 (live md5 %) -- re-derive', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_thin_fmv_editions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count integer;
  v_rows  public.topshot_thin_fmv_editions[];
BEGIN
  -- 2026-10-17: COMPUTE FIRST, then swap. TRUNCATE takes ACCESS EXCLUSIVE and holds it to
  -- COMMIT; with the ~12 s median scan below inside that window, every reader of this table
  -- (topshot_deals_vs_fmv -> get_edition_insight_links on EVERY edition page, the deals boards)
  -- blocked for the whole build: 9 edition-page statement timeouts in 4 s at 1:30 AM PT 10-17.
  -- The rows are built into an array with no lock held; the lock now covers only the insert.
  SELECT coalesce(array_agg(ROW(c.edition_id, c.fmv_usd, m.median_90d, m.n_90d, now())::public.topshot_thin_fmv_editions), '{}')
    INTO v_rows
  FROM (
    -- Cheap prefilter using the stored snapshot column: HIGH/MEDIUM editions that are already thin
    -- (sales_count_30d 1..14) -- narrows the median-scan set without touching the sales table.
    SELECT e.id AS edition_id, lf.fmv_usd
    FROM public.editions e
    JOIN LATERAL (
      SELECT fs.confidence, fs.sales_count_30d, fs.fmv_usd
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
        AND fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND lf.fmv_usd > 0
      AND lf.sales_count_30d BETWEEN 1 AND 14
  ) c
  JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)::numeric AS median_90d,
           count(*)::integer AS n_90d
    FROM public.sales_market s
    WHERE s.edition_id = c.edition_id
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
  ) m ON true
  -- Precise definition: thin (<15 sales/90d) AND FMV inflated >1.5x above the 90d median.
  WHERE m.n_90d < 15
    AND m.median_90d > 0
    AND c.fmv_usd > 1.5 * m.median_90d;

  TRUNCATE public.topshot_thin_fmv_editions;

  INSERT INTO public.topshot_thin_fmv_editions (edition_id, fmv_usd, median_90d, n_90d, computed_at)
  SELECT r.edition_id, r.fmv_usd, r.median_90d, r.n_90d, r.computed_at
  FROM unnest(v_rows) AS r;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

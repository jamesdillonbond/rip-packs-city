-- database.md (2026-09-02) left this on the table: 15 `.in("edition_id", …)` reads of the
-- `fmv_current` DISTINCT ON view remain across 13 files; nine could use
-- `get_editions_latest_fmv(uuid[])` (4 columns) and FIVE cannot because they need
-- sales_count_30d / wap_usd / floor_price_usd / days_since_sale — `fetchFmvBatch`, `/api/fmv`,
-- `/api/wallet-search` ×2, `/api/cache-refresh`. Those five are the product's hottest shape:
-- pg_stat_statements since 08-11, the 5-column id-list read of fmv_current — 6,103 calls,
-- mean 6,204 ms, 631 minutes of DB time, 1,203 physical blocks per call (read 2026-09-19
-- 9:40 PM PT); the 8-column shape another 902 calls at 6,046 ms. A qual on the DISTINCT ON
-- key reaches the index but does not bound the rows per group, so every call walks every
-- snapshot of every requested edition (~35–80 each) and Unique discards all but one.
--
-- This is the narrow helper's exact selection rule (per-id LATERAL … ORDER BY computed_at DESC
-- LIMIT 1, computed_at <= now(), plpgsql so the plan keeps the per-id probe) widened to every
-- column the view exposes, so any of the 15 readers can move without a second migration.
-- service_role only, like the narrow one (these are server routes; anon has never read
-- fmv_current through PostgREST by design of the routes that wrap it).
--
-- ⚠ The first apply of this file carried an in-migration set-difference A/B against
-- fmv_current on 500 ids and DIED AT THE 60 s MCP CAP (the view side alone is 10+ s cold —
-- which is the point). Rolled back whole; the A/B was run by hand instead and its numbers are
-- in the ledger entry of the same date. Nothing in this file reads the view.
-- Applied from Cowork cloud 2026-09-19 9:4x PM PT. ⚠ That session's push tooling is its own
-- concern; this file commits as usual. The route half (wallet-search ×2, cache-refresh) ships
-- separately with its tests; this function is inert until a caller lands.
--
-- Hand A/B, 2026-09-19 ~9:50–10:05 PM PT, one fixed list of 100 Top Shot edition ids
-- (the wallet-search chunk shape), EXPLAIN (ANALYZE, BUFFERS):
--   fmv_current WHERE edition_id = ANY(<100>)  cold: 7,609 snapshot rows scanned, 7,405 buffers
--                                              (5,763 read), 40,883 ms;
--                                              warm-ish rerun: 7,403 buffers (5,325 read), 22,552 ms
--   get_editions_latest_fmv_wide(<100>)        1,617 buffers (97 read), 40 ms
--   set difference on (edition_id, fmv_usd, computed_at), both directions: 0 and 0, 100 rows each side.
-- The view's cost is the ~76 snapshots per edition it walks before Unique; the helper's is
-- one index probe per id. Same rows, ~500× less time at the chunk size the routes use.
--
-- REVERT: DROP FUNCTION public.get_editions_latest_fmv_wide(uuid[]);
--
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated below; service_role only, same as get_editions_latest_fmv (get_editions_latest_fmv_wide)

CREATE OR REPLACE FUNCTION public.get_editions_latest_fmv_wide(p_edition_ids uuid[])
 RETURNS TABLE(
   edition_id uuid,
   collection_id uuid,
   fmv_usd numeric,
   floor_price_usd numeric,
   wap_usd numeric,
   confidence text,
   top_shot_ask numeric,
   flowty_ask numeric,
   cross_market_ask numeric,
   computed_at timestamptz,
   algo_version text,
   asp_without_outliers numeric,
   sales_count_30d integer,
   days_since_sale integer,
   liquidity_rating integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- plpgsql, not LANGUAGE sql: a sql-language function is planned param-blind and this
  -- plan's whole value is the per-id index probe (see get_editions_latest_fmv).
  RETURN QUERY
  SELECT e.id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.asp_usd, s.confidence::text,
         s.top_shot_ask, s.flowty_ask, s.cross_market_ask, s.computed_at, s.algo_version,
         s.asp_without_outliers, s.sales_count_30d, s.days_since_sale, s.liquidity_rating
  FROM unnest(COALESCE(p_edition_ids, ARRAY[]::uuid[])) AS e(id)
  CROSS JOIN LATERAL (
    SELECT fs.collection_id, fs.fmv_usd, fs.floor_price_usd, fs.asp_usd, fs.confidence,
           fs.top_shot_ask, fs.flowty_ask, fs.cross_market_ask, fs.computed_at, fs.algo_version,
           fs.asp_without_outliers, fs.sales_count_30d, fs.days_since_sale, fs.liquidity_rating
    FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id
      AND fs.computed_at <= now()
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) s;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_editions_latest_fmv_wide(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_editions_latest_fmv_wide(uuid[]) TO service_role;

COMMENT ON FUNCTION public.get_editions_latest_fmv_wide(uuid[]) IS
  'Latest fmv_snapshots row per requested edition, every column the fmv_current view exposes (wap_usd = asp_usd). Same selection rule as get_editions_latest_fmv; exists because five readers needed columns the 4-column helper lacks. Per-id index probe; cost is linear in the id count (~72 buffers/id warm). Added 2026-09-19.';

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_editions_latest_fmv_wide(uuid[])', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
  IF has_function_privilege('authenticated', 'public.get_editions_latest_fmv_wide(uuid[])', 'EXECUTE') THEN RAISE EXCEPTION 'authenticated EXECUTE leaked'; END IF;
  IF NOT has_function_privilege('service_role', 'public.get_editions_latest_fmv_wide(uuid[])', 'EXECUTE') THEN RAISE EXCEPTION 'service_role missing EXECUTE'; END IF;
END $$;

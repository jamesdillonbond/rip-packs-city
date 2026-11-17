-- 2026-10-04 (PT) — get_collection_stats: the volume leg reads the last 7 days of sales_2026,
-- not every sale this year.
--
-- WHY. Vercel, 6 h to ~9:35 AM PT 10-04: 7 × `/api/collection-stats` 503
-- `RPC_READ_TIMEOUT … read exceeded 8000ms`, mostly the first cold call after a deploy. The
-- function costs 270 k buffers for Top Shot (1.1 s warm), and 237,551 of them are one leg:
--   SELECT price_usd, sold_at FROM sales_2026 WHERE collection_id = v_collection_id
--   UNION ALL SELECT … FROM sales_2025 WHERE collection_id = … AND sold_at > NOW() - '7 days'
-- The 2026 arm has NO date filter, so it reads all 1.09 M Top Shot sales of 2026 (grown
-- overnight by the Flowty/Dapper promotion) to sum the ~19 k sold in the last 7 days.
--
-- WHAT. The 2026 arm gets the same `sold_at > NOW() - INTERVAL '7 days'` the 2025 arm already
-- has. Equivalent BY CONSTRUCTION: the three outputs are SUM/COUNT over CASE WHEN sold_at > now()
-- - 24h / - 7 days, so a row older than 7 days contributes nothing to any of them.
-- Measured, same query, Top Shot: 237,551 -> 1,190 buffers (Index Only Scan on
-- idx_sales_2026_summary_cover with both bounds), 428 ms -> 15 ms warm.
--
-- HOW. In place, the pattern of 20260929020928: guard on the live body md5, replace one exact
-- anchor in pg_get_functiondef (count asserted = 1), EXECUTE. Nothing else changes; ACL and
-- SECURITY DEFINER are preserved by CREATE OR REPLACE.
-- anon-exec: unchanged (get_collection_stats) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- REVERT: the same splice with v_old and v_new swapped (guard on the new md5).

DO $splice$
DECLARE
  v_oid oid;
  v_def text;
  v_old text;
  v_new text;
  v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_collection_stats'
     AND pg_get_function_identity_arguments(p.oid) = 'p_slug text';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_collection_stats(text) missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> '0b6b3eb857f656795bf014034eef2e90' THEN
    RAISE EXCEPTION 'get_collection_stats body drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);

  v_old := E'      SELECT price_usd, sold_at FROM sales_2026 WHERE collection_id = v_collection_id\n'
        || E'      UNION ALL\n';
  v_new := E'      -- 2026-10-04: bounded like the 2025 arm. Only the last 7 days reach any output,\n'
        || E'      -- and unbounded this read every 2026 sale (237 k buffers for Top Shot).\n'
        || E'      SELECT price_usd, sold_at FROM sales_2026 WHERE collection_id = v_collection_id\n'
        || E'        AND sold_at > NOW() - INTERVAL ''7 days''\n'
        || E'      UNION ALL\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$splice$;

-- Post-flight: Top Shot (the largest) must answer well inside the route's 8 s read budget.
DO $verify$
DECLARE
  v_out jsonb; v_t0 timestamptz; v_ms numeric;
BEGIN
  v_t0 := clock_timestamp();
  v_out := public.get_collection_stats('nba_top_shot');
  v_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000;
  IF v_ms > 8000 THEN RAISE EXCEPTION 'nba_top_shot takes % ms', round(v_ms); END IF;
  IF v_out ? 'error' THEN RAISE EXCEPTION 'nba_top_shot returned %', v_out; END IF;
  RAISE NOTICE 'nba_top_shot % ms; volume_24h %, sales_24h %, volume_7d %',
    round(v_ms), v_out->>'volume_24h', v_out->>'sales_24h', v_out->>'volume_7d';
END
$verify$;

-- audit_20261019_panini_arms_market_summary_wallet_stats_smoke
--
-- #64 residue, rollups 3–5 of 5 (search 10-14, readiness 10-19 earlier today). Each of
-- these filtered `collections.is_active = true`, so flipping Panini's flag would have
-- enrolled it into reads over `sales` / `wallet_moments_cache`, where Panini has 0 rows
-- — fabricated zeros (#64). After this file, none of the five depends on the flag for
-- Panini, and none can publish a Panini zero.
--
-- (1) get_market_summary — a Panini ARM from Panini's own tables. Panini sales reach
--     panini_sales 12–160 h after sold_at (the runner's walk age), so the 24 h and
--     7 d fields are NULL for Panini, never a count: measured 10-19 the last 7 d held
--     6,506 recorded sales against 9,962 and 9,778 in the two weeks before (−35 %, all
--     lag). What it does carry: `settled_week` = sales with sold_at in (now−14 d,
--     now−7 d], past the bulk of the lag, labelled with its window; editions_total and
--     editions_with_fmv as for every collection. The Flow arm is unchanged and now
--     also excludes Panini by slug, so a flip cannot double it.
-- (2) get_wallet_collection_stats — Panini EXCLUDED by slug, deliberately not armed.
--     It is keyed by a wallet ADDRESS; a Panini owner is a USERNAME (lib/address.ts
--     isPaniniUsername), held in saved_collector_identities and shown by
--     /api/profile/collector-identities. No address can hold a Panini card, so an arm
--     here could only ever emit 0 moments / $0 per wallet. No change today (Panini is
--     inactive); it removes the flip's zero row.
-- (3) analytics_smoke_run — Panini sale + FMV freshness legs from panini_sales /
--     panini_fmv_snapshots, like Pinnacle's. Sale threshold 72 h (4,320 min), matching
--     the Sentinel Panini arm's newest-sale warn, because the walk can legitimately go
--     a night without new rows (the laptop sleeps); FMV threshold 30 h, stale only when
--     a sale with sold_at after the latest FMV is recorded (the 10-09 rule). Both
--     Flow CTEs exclude Panini by slug. Applied as the 10-09 md5-gated anchor rewrite
--     (function unpinned, 23 k chars); six anchors, each asserted to occur once.
--     Cost of the two Panini probes: 13 buffers (index-only, measured 10-19).
--
-- anon-exec: unchanged (get_market_summary) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
-- anon-exec: unchanged (get_wallet_collection_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
-- anon-exec: unchanged (analytics_smoke_run) — rewritten via pg_get_functiondef; ACL preserved, verified has_function_privilege anon=false.
--
-- md5(prosrc) before → after: get_market_summary 81157d1f… → 80ef902b…;
-- get_wallet_collection_stats 892e372e… → 5cc5e0ec305eb1b4e19106299fc6ec75;
-- analytics_smoke_run e83d23aa… → aafd63ad82ca9164789fac13f0b4a665.
--
-- REVERT: re-apply get_market_summary's body from 20260830165128 (search_path
-- 'public','pg_temp'); for the other two run this file's anchor replacements in reverse
-- (b→a), gated on the "after" md5s above.

CREATE OR REPLACE FUNCTION public.get_market_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_object_agg(slug, stats)
  FROM (
    SELECT 
      c.slug,
      jsonb_build_object(
        'sales_24h', (SELECT COUNT(*) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '24 hours' AND price_usd > 0),
        'volume_24h_usd', (SELECT ROUND(COALESCE(SUM(price_usd), 0)::numeric, 0) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '24 hours'),
        'sales_7d', (SELECT COUNT(*) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days' AND price_usd > 0),
        'volume_7d_usd', (SELECT ROUND(COALESCE(SUM(price_usd), 0)::numeric, 0) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days'),
        'distinct_buyers_7d', (SELECT COUNT(DISTINCT buyer_address) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days' AND buyer_address IS NOT NULL),
        'avg_price_7d', (SELECT ROUND(COALESCE(AVG(price_usd), 0)::numeric, 2) FROM sales WHERE collection_id = c.id AND sold_at > NOW() - INTERVAL '7 days' AND price_usd > 0),
        'editions_total', (SELECT COUNT(*) FROM editions WHERE collection_id = c.id),
        -- edition_fmv_current = the same latest-row-per-edition set as the fmv_current view, materialised hourly.
        'editions_with_fmv', (SELECT COUNT(*) FROM edition_fmv_current WHERE collection_id = c.id)
      ) AS stats
    FROM collections c
    WHERE c.is_active = true
      AND c.slug <> 'panini_blockchain'   -- #64: Panini's arm below, never the `sales` read
    UNION ALL
    -- #64 Panini arm (2026-10-19): lag-aware. 24 h / 7 d are NULL (unknown, not 0);
    -- `settled_week` reads the week that has cleared the bulk of the ingest lag.
    SELECT
      c.slug,
      jsonb_build_object(
        'sales_24h', NULL::bigint,
        'volume_24h_usd', NULL::numeric,
        'sales_7d', NULL::bigint,
        'volume_7d_usd', NULL::numeric,
        'distinct_buyers_7d', NULL::bigint,
        'avg_price_7d', NULL::numeric,
        'settled_week', (
          SELECT jsonb_build_object(
                   'from', now() - INTERVAL '14 days',
                   'to', now() - INTERVAL '7 days',
                   'sales', COUNT(*),
                   'volume_usd', ROUND(COALESCE(SUM(ps.amount_usd), 0)::numeric, 0),
                   'distinct_buyers', COUNT(DISTINCT ps.buyer),
                   'avg_price', ROUND(AVG(ps.amount_usd)::numeric, 2),
                   'note', 'Panini sales are recorded 12–160 h after they happen; this is the most recent week past most of that lag.')
            FROM panini_sales ps
           WHERE ps.sold_at >  now() - INTERVAL '14 days'
             AND ps.sold_at <= now() - INTERVAL '7 days'
             AND ps.amount_usd > 0),
        'editions_total', (SELECT COUNT(*) FROM editions WHERE collection_id = c.id),
        'editions_with_fmv', (SELECT COUNT(*) FROM edition_fmv_current WHERE collection_id = c.id)
      ) AS stats
    FROM collections c
    WHERE c.slug = 'panini_blockchain'
  ) sub;
$function$;

-- (2) get_wallet_collection_stats: md5-gated anchor rewrite (header, SETs and ACL preserved).
DO $$
DECLARE
  v_oid oid; v_src text; v_def text;
  a1 constant text := E'  WHERE c.is_active = TRUE\n  GROUP BY c.id, c.slug, c.name';
  b1 constant text := E'  WHERE c.is_active = TRUE\n    -- #64 (2026-10-19): an ADDRESS cannot hold a Panini card (owners are usernames,\n    -- saved_collector_identities); a Panini row here could only ever read 0 / $0.\n    AND c.slug <> ''panini_blockchain''\n  GROUP BY c.id, c.slug, c.name';
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_collection_stats';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_wallet_collection_stats not found'; END IF;
  IF md5(v_src) <> '892e372eb4b81ff25544b678abe48155' THEN
    RAISE EXCEPTION 'get_wallet_collection_stats changed since read (md5 %)', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, a1, ''))) / length(a1) <> 1 THEN
    RAISE EXCEPTION 'wallet-stats anchor does not occur exactly once';
  END IF;
  v_def := replace(pg_get_functiondef(v_oid), a1, b1);
  EXECUTE v_def;
END $$;

-- (3) analytics_smoke_run: md5-gated six-anchor rewrite (the 20261009202625 pattern).
DO $$
DECLARE
  v_oid oid; v_src text; v_def text; v_a text;
  a1 constant text := E'          WHERE s.collection_id = c.id ORDER BY s.sold_at DESC LIMIT 1\n        ) ls ON true\n        WHERE c.is_active = true AND c.slug != ''disney_pinnacle''),';
  b1 constant text := E'          WHERE s.collection_id = c.id ORDER BY s.sold_at DESC LIMIT 1\n        ) ls ON true\n        WHERE c.is_active = true AND c.slug != ''disney_pinnacle'' AND c.slug != ''panini_blockchain''),';
  a2 constant text := E'        FROM (SELECT sold_at FROM pinnacle_sales ORDER BY sold_at DESC LIMIT 1) ps),\n      combined AS (SELECT * FROM freshness UNION ALL SELECT * FROM pinnacle)';
  b2 constant text := E'        FROM (SELECT sold_at FROM pinnacle_sales ORDER BY sold_at DESC LIMIT 1) ps),\n      -- #64 (2026-10-19): Panini sales live in panini_sales, recorded 12-160 h late; 72 h threshold below.\n      panini AS (\n        SELECT ''panini_blockchain'' AS slug, pz.sold_at AS last_sale,\n               EXTRACT(EPOCH FROM now() - pz.sold_at) / 60 AS minutes_stale\n        FROM (SELECT sold_at FROM panini_sales WHERE sold_at <= now() ORDER BY sold_at DESC LIMIT 1) pz),\n      combined AS (SELECT * FROM freshness UNION ALL SELECT * FROM pinnacle UNION ALL SELECT * FROM panini)';
  a3 constant text := E'count(*) FILTER (WHERE minutes_stale > 1440 AND NOT (slug = ANY(v_low_volume_collections)))';
  b3 constant text := E'count(*) FILTER (WHERE minutes_stale > CASE WHEN slug = ''panini_blockchain'' THEN 4320 ELSE 1440 END AND NOT (slug = ANY(v_low_volume_collections)))';
  a4 constant text := E'        ) lf ON true\n        WHERE c.is_active = true AND c.slug != ''disney_pinnacle''),';
  b4 constant text := E'        ) lf ON true\n        WHERE c.is_active = true AND c.slug != ''disney_pinnacle'' AND c.slug != ''panini_blockchain''),';
  a5 constant text := E'               true AS has_newer_sale\n        FROM pinnacle_catalog),\n      combined AS (SELECT * FROM fmv UNION ALL SELECT * FROM pinnacle),';
  b5 constant text := E'               true AS has_newer_sale\n        FROM pinnacle_catalog),\n      -- #64 (2026-10-19): Panini FMV lives in panini_fmv_snapshots; stale only when a sale\n      -- sold after the latest FMV has been recorded (the 10-09 rule, on Panini''s own tables).\n      panini AS (\n        SELECT ''panini_blockchain'' AS slug, EXTRACT(EPOCH FROM now() - pf.m) / 60 AS minutes_stale,\n               (pf.m IS NULL OR EXISTS (SELECT 1 FROM panini_sales s WHERE s.sold_at > pf.m AND s.sold_at <= now())) AS has_newer_sale\n        FROM (SELECT max(computed_at) AS m FROM panini_fmv_snapshots) pf),\n      combined AS (SELECT * FROM fmv UNION ALL SELECT * FROM pinnacle UNION ALL SELECT * FROM panini),';
  a6 constant text := E'(''ufc_strike'', 1800), (''disney_pinnacle'', 1800)';
  b6 constant text := E'(''ufc_strike'', 1800), (''disney_pinnacle'', 1800), (''panini_blockchain'', 1800)';
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'analytics_smoke_run' AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'analytics_smoke_run() not found'; END IF;
  IF md5(v_src) <> 'e83d23aa71beed901b104fffaa581057' THEN
    RAISE EXCEPTION 'analytics_smoke_run changed since read (md5 %)', md5(v_src);
  END IF;
  FOREACH v_a IN ARRAY ARRAY[a1, a2, a3, a4, a5, a6] LOOP
    IF (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a) <> 1 THEN
      RAISE EXCEPTION 'smoke anchor does not occur exactly once: %', left(v_a, 80);
    END IF;
  END LOOP;
  v_def := pg_get_functiondef(v_oid);
  v_def := replace(replace(replace(replace(replace(replace(v_def, a1, b1), a2, b2), a3, b3), a4, b4), a5, b5), a6, b6);
  EXECUTE v_def;
END $$;

DO $$
DECLARE v_src text; v_ws text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'analytics_smoke_run';
  SELECT prosrc INTO v_ws FROM pg_proc WHERE proname = 'get_wallet_collection_stats';
  IF strpos(v_src, 'FROM panini_sales WHERE sold_at <= now() ORDER BY sold_at DESC LIMIT 1') = 0
     OR strpos(v_src, 'FROM panini_fmv_snapshots) pf') = 0
     OR strpos(v_src, '(''panini_blockchain'', 1800)') = 0
     OR strpos(v_ws, 'AND c.slug <> ''panini_blockchain''') = 0 THEN
    RAISE EXCEPTION 'Panini arms did not land';
  END IF;
  RAISE NOTICE 'analytics_smoke_run md5 % / get_wallet_collection_stats md5 %', md5(v_src), md5(v_ws);
END $$;

-- audit_20261127_topshot_forward_test_splits_parcap
--
-- 2026-11-27 (Claude Code cloud; Trevor: "leaving nothing from this thread unresolved"). 20261127213224 tags the new
-- never-sold Top Shot parallel hold "_parcap_compcap" so every reader shows "held to comparables"; the forward test
-- (20261127184110) matched '_compcap' and would have scored those rows inside its 'compcap' arm, blurring both rules.
-- One change: a '_parcap' arm, tested before '_compcap'. Nothing else in the body changes.
--
-- anon-exec: unchanged (topshot_ask_only_forward_test) — CREATE OR REPLACE of the same signature keeps its live ACL (service_role only; 20261127184110).
--
-- REVERT: re-apply the topshot_ask_only_forward_test body from 20261127184110 (prosrc md5 c9d176eb02eb5a01231d4bd2373efa11).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.topshot_ask_only_forward_test(timestamptz)'::regprocedure)
     <> 'c9d176eb02eb5a01231d4bd2373efa11' THEN
    RAISE EXCEPTION 'topshot_ask_only_forward_test changed since it was read; re-derive this migration';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.topshot_ask_only_forward_test(p_since timestamptz DEFAULT '2026-11-27 18:00:00+00')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH fs AS (
    SELECT m.edition_id, min(m.sold_at) AS t0
      FROM public.sales_market m
     WHERE m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND m.price_usd > 0 AND m.sold_at > p_since
     GROUP BY 1
  ), first_sales AS (
    SELECT fs.* FROM fs
     WHERE NOT EXISTS (SELECT 1 FROM public.sales_market p WHERE p.edition_id = fs.edition_id AND p.sold_at < fs.t0 AND p.price_usd > 0)
  ), sc AS (
    SELECT (SELECT m.price_usd FROM public.sales_market m WHERE m.edition_id = f.edition_id AND m.sold_at = f.t0 LIMIT 1) AS actual,
           sn.fmv_usd AS pub,
           CASE WHEN sn.algo_version ~ '_tiercap' THEN 'tiercap' WHEN sn.algo_version ~ '_parcap' THEN 'parcap' WHEN sn.algo_version ~ '_compcap' THEN 'compcap'
                WHEN sn.algo_version ~ '_bidpull' THEN 'bidpull' ELSE 'ask' END
             || CASE WHEN e.tier IN ('LEGENDARY', 'ULTIMATE') THEN ':LU' ELSE ':other' END AS arm
      FROM first_sales f
      JOIN public.editions e ON e.id = f.edition_id
      JOIN LATERAL (SELECT x.fmv_usd, x.confidence, x.algo_version FROM public.fmv_snapshots x
                     WHERE x.edition_id = f.edition_id AND x.computed_at < f.t0 AND x.fmv_usd > 0
                     ORDER BY x.computed_at DESC LIMIT 1) sn ON sn.confidence = 'ASK_ONLY'
  )
  SELECT COALESCE(jsonb_object_agg(arm, j), '{}'::jsonb)
    FROM (SELECT arm, jsonb_build_object(
                   'n', count(*),
                   'mdae', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(ln(actual / pub)))::numeric, 3),
                   'bias', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ln(actual / pub))::numeric, 3),
                   'within_25pct', round(avg((abs(ln(actual / pub)) <= ln(1.25))::int)::numeric, 3),
                   'wape', round((sum(abs(actual - pub)) / NULLIF(sum(actual), 0))::numeric, 3)) AS j
            FROM sc WHERE actual > 0 GROUP BY arm) z;
$function$;


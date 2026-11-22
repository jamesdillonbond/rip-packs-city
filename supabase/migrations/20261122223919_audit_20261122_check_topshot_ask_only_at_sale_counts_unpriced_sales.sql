-- audit_20261122_check_topshot_ask_only_at_sale_counts_unpriced_sales — 2026-11-22 ~2:39 PM PT (Claude Code cloud,
-- autonomous pass; found by a fresh-eyes review of c1eaa9309).
--
-- WHY. 20261122173426 joined each sale to the snapshot live at the sale with `JOIN LATERAL … ON pv.v > 0`, so a
-- sale whose edition had NO published price yet dropped out of the numerator AND the denominator. That is the worst
-- form of the failure the arm exists for: if fmv-recalc's hot lane stops on a drop day, new editions never get a
-- snapshot, their sales vanish, the ASK_ONLY share stays low and the arm reads ok.
-- Calibrated on 16 days of 6 h windows (unpriced share): every window ≤ 3.2 % (the 11-11 drop window 3.2 %, 51 of
-- 1,618) EXCEPT 2026-11-18 18:00–24:00 UTC: **17.6 % (178 of 1,009)** — an event the existing arm could not see.
--
-- WHAT. Same function, same signature, same existing keys and values. LEFT JOIN LATERAL keeps every sale; the
-- existing aggregates FILTER to priced sales (identical numbers), and two keys are added: sales_total, sales_unpriced
-- (no snapshot at or before the sale, or a non-positive one). The sentinel arm warns on the unpriced share
-- (lib/sentinel/topshot-ask-only-at-sale.ts). Body otherwise = 20261122173426 (prosrc md5 asserted below).
--
-- anon-exec: unchanged (check_topshot_ask_only_at_sale) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- REVERT: re-apply 20261122173426_audit_20261122_check_topshot_ask_only_at_sale.sql.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.check_topshot_ask_only_at_sale(integer)'::regprocedure)
     IS DISTINCT FROM '21ac68fb53757127bed4f5f1d2966167' THEN
    RAISE EXCEPTION 'check_topshot_ask_only_at_sale is not the 20261122173426 body; re-read it and re-base';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.check_topshot_ask_only_at_sale(p_hours integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
  WITH s AS (
    SELECT sm.edition_id, sm.sold_at, sm.price_usd
      FROM public.sales_market sm
     WHERE sm.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND sm.sold_at > now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 6), 48)))
       AND COALESCE(sm.serial_number, 999999) > 25
       AND sm.price_usd > 0
  ), j AS (
    -- LEFT: a sale with no published price at the sale stays in the population (2026-11-22).
    SELECT pv.c, pv.v / s.price_usd AS r, (pv.v IS NOT NULL AND pv.v > 0) AS priced
      FROM s
      LEFT JOIN LATERAL (
        SELECT x.fmv_usd AS v, x.confidence::text AS c
          FROM public.fmv_snapshots x
         WHERE x.edition_id = s.edition_id AND x.computed_at <= s.sold_at
         ORDER BY x.computed_at DESC LIMIT 1) pv ON true
  )
  SELECT jsonb_build_object(
    'hours', greatest(1, least(coalesce(p_hours, 6), 48)),
    'sales_priced', count(*) FILTER (WHERE priced),
    'ask_only_sales', count(*) FILTER (WHERE priced AND c = 'ASK_ONLY'),
    'ask_only_pct', round(100.0 * avg((c = 'ASK_ONLY')::int) FILTER (WHERE priced), 1),
    'ask_only_median_ratio', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r) FILTER (WHERE priced AND c = 'ASK_ONLY'))::numeric, 2),
    'within_25_pct', round(100.0 * avg((abs(r - 1) <= 0.25)::int) FILTER (WHERE priced), 1),
    'sales_total', count(*),
    'sales_unpriced', count(*) FILTER (WHERE NOT priced)
  )
  FROM j;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_topshot_ask_only_at_sale(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_topshot_ask_only_at_sale(integer) TO service_role;

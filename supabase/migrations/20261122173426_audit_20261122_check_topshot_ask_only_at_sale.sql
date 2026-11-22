-- audit_20261122_check_topshot_ask_only_at_sale
--
-- 2026-11-22 ~9:50 AM PT (Claude Code cloud; Trevor: "Keep going and digging and probing and come up with a strategy";
-- docs/strategy/strategy-2026-11-22.md, Move 1.1).
-- WHY: on the 11-11 Series 9 / Rookie Debut launch, 37.6 % of Top Shot sales cleared while the LIVE price was
-- ASK_ONLY, at a median 2.16x the sale price (within +/-25 % at sale fell ~79 -> 47.8 %). A hot new edition went
-- ~20 h between snapshots under 37 sales. Nothing alarmed: fmv_accuracy_weekly stored it 12 days later, by design.
-- WHAT: a read-only check over the last p_hours of Top Shot market sales (serial > 25, price > 0): how many sold
-- against an ASK_ONLY price (the snapshot live AT the sale), the median published/sale ratio of those, and the
-- within-25 % share. 16-day calibration in 6 h windows: the four 11-11/11-12 drop windows read 22.6-58.8 % ASK_ONLY
-- at ratio 1.93-2.43; every other window <= 4.7 %. Cost: ~2k buffers, ~0.2 s at 6 h.
-- anon-exec: REVOKED -- sentinel-only (service_role); a public caller has no use for it.
-- REVERT: DROP FUNCTION public.check_topshot_ask_only_at_sale(integer);

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
    SELECT pv.c, pv.v / s.price_usd AS r
      FROM s
      JOIN LATERAL (
        SELECT x.fmv_usd AS v, x.confidence::text AS c
          FROM public.fmv_snapshots x
         WHERE x.edition_id = s.edition_id AND x.computed_at <= s.sold_at
         ORDER BY x.computed_at DESC LIMIT 1) pv ON pv.v > 0
  )
  SELECT jsonb_build_object(
    'hours', greatest(1, least(coalesce(p_hours, 6), 48)),
    'sales_priced', count(*),
    'ask_only_sales', count(*) FILTER (WHERE c = 'ASK_ONLY'),
    'ask_only_pct', round(100.0 * avg((c = 'ASK_ONLY')::int), 1),
    'ask_only_median_ratio', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r) FILTER (WHERE c = 'ASK_ONLY'))::numeric, 2),
    'within_25_pct', round(100.0 * avg((abs(r - 1) <= 0.25)::int), 1)
  )
  FROM j;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_topshot_ask_only_at_sale(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_topshot_ask_only_at_sale(integer) TO service_role;

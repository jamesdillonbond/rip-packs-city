-- audit_20261029_hub_squeeze_tile_counts_what_it_says — 2026-10-29 10:37 AM PT applied (Claude Code cloud).
--
-- /insights read "14,502 editions ≥50% squeezed" on the Lock-Rate Squeeze Board tile
-- (lib/insights-hub-format.ts). squeezeEditions counted EVERY row of topshot_squeeze_board; the count at
-- >= 50 % on 10-29 was 5,770. The board's own default view is squeeze_pct >= 50
-- (lib/insights/squeeze-board.ts minSqueeze = 50), so the tile now counts that population.
--
-- WHAT CHANGES: squeezeEditions only. Every other key, the signature, SECURITY DEFINER, search_path
-- and ACL are unchanged (same-signature CREATE OR REPLACE keeps grants).
-- anon-exec: unchanged (get_insights_hub_stats) — same-signature CREATE OR REPLACE keeps its ACL; verified has_function_privilege('anon') = false before and after.
-- REVERT: re-apply the body in 20261021025602 (squeezeEditions = count(*) with no filter).

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.get_insights_hub_stats()'::regprocedure) <> '8aeb1dd376872f1b3f40ac338da931b1' THEN
    RAISE EXCEPTION 'live get_insights_hub_stats changed since 2026-10-29; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_insights_hub_stats()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH recent_sales AS MATERIALIZED (
    SELECT sold_at, price_usd
    FROM sales
    WHERE sold_at >= now() - interval '7 days'
      AND price_usd > 0
    UNION ALL
    SELECT sold_at, sale_price_usd
    FROM pinnacle_sales
    WHERE sold_at >= now() - interval '7 days'
      AND sale_price_usd > 0
    UNION ALL
    SELECT sold_at, amount_usd
    FROM panini_sales
    WHERE sold_at >= now() - interval '7 days'
      AND amount_usd > 0
  )
  SELECT jsonb_build_object(
    'insights', jsonb_build_object(
      'squeezeEditions',   (SELECT count(*)::int FROM topshot_squeeze_board WHERE squeeze_pct >= 50),
      'setSqueezeSets',    (SELECT count(*)::int FROM topshot_set_squeeze_board),
      'pinnacleEditions',  (SELECT count(*)::int FROM pinnacle_scarcity_board),
      'packZeroPct',       (SELECT round(zero_value_pct::numeric, 0)::int FROM topshot_pack_reality_stats LIMIT 1),
      'packRips60d',       (SELECT rips_60d::int FROM topshot_pack_reality_stats LIMIT 1),
      'rookieGmv30d',      (SELECT round(total_gmv_30d::numeric, 0)::int FROM topshot_2025_rookie_cohort_stats LIMIT 1),
      'rookieCount',       (SELECT rookie_count::int FROM topshot_2025_rookie_cohort_stats LIMIT 1),
      'firstMintAvg',      (SELECT round(avg_multiplier::numeric, 1) FROM topshot_first_mint_trophy_stats LIMIT 1),
      'firstMintMax',      (SELECT round(max_multiplier::numeric, 0)::int FROM topshot_first_mint_trophy_stats LIMIT 1),
      'crossCohort',       (SELECT cohort_size::int FROM cross_collection_cohort_stats LIMIT 1)
    ),
    'market', jsonb_build_object(
      'sales24h', (SELECT count(*)::int FROM recent_sales WHERE sold_at >= now() - interval '24 hours'),
      'gmv24h',   (SELECT round(COALESCE(sum(price_usd), 0)::numeric, 0)::bigint FROM recent_sales WHERE sold_at >= now() - interval '24 hours'),
      'sales7d',  (SELECT count(*)::int FROM recent_sales),
      'gmv7d',    (SELECT round(COALESCE(sum(price_usd), 0)::numeric, 0)::bigint FROM recent_sales)
    ),
    'computedAt', now()
  );
$function$;

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.get_insights_hub_stats()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon gained EXECUTE on get_insights_hub_stats';
  END IF;
  IF (public.get_insights_hub_stats() #>> '{insights,squeezeEditions}')::int
     <> (SELECT count(*) FROM topshot_squeeze_board WHERE squeeze_pct >= 50) THEN
    RAISE EXCEPTION 'squeezeEditions does not count the >= 50 %% population';
  END IF;
END
$post$;

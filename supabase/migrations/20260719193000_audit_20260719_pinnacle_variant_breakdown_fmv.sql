-- Adds get_pinnacle_variant_breakdown: the variant analogue of
-- get_pinnacle_franchise_breakdown. Groups the wallet's Pinnacle pins by variant
-- (wallet_moments_cache.tier) and returns count + total_fmv per variant, ordered
-- by the canonical pinnacle_variant_rank.
--
-- Motivation: app/api/pinnacle-wallet/route.ts hardcoded variant total_fmv to
-- null because get_pinnacle_variant_counts returns only counts, so the wallet-view
-- variant chips never showed an FMV total even though the franchise chips (fed by
-- get_pinnacle_franchise_breakdown) already do. The UI (disney-pinnacle/collection)
-- already renders v.total_fmv when non-null, so this closes a visible gap.
--
-- Filter/group are byte-identical to get_pinnacle_variant_counts, so the per-
-- variant counts stay consistent with that RPC; the fmv SUM matches the franchise
-- RPC's ROUND(COALESCE(SUM(wmc.fmv_usd),0),2) shape. Plain STABLE (not SECDEF),
-- mirroring both siblings. Additive — the counts RPC is left untouched.
--
-- Reversal: DROP FUNCTION public.get_pinnacle_variant_breakdown(text);

CREATE OR REPLACE FUNCTION public.get_pinnacle_variant_breakdown(p_wallet text)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(json_agg(json_build_object(
    'variant', tier,
    'count', cnt,
    'total_fmv', total_fmv
  ) ORDER BY rank), '[]'::json)
  FROM (
    SELECT tier,
           count(*)::int AS cnt,
           ROUND(COALESCE(SUM(fmv_usd), 0), 2) AS total_fmv,
           pinnacle_variant_rank(tier) AS rank
    FROM wallet_moments_cache
    WHERE wallet_address = p_wallet
      AND collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
      AND tier IS NOT NULL
    GROUP BY tier
  ) sub;
$function$;

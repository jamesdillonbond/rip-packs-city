CREATE OR REPLACE FUNCTION public.aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- AUTHZ: caller must be the user they claim to be (service_role bypasses)
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH agg AS (
    SELECT
      wmc.collection_id,
      COUNT(*) AS moment_count,
      COALESCE(SUM(wmc.fmv_usd), 0) AS fmv_sum,
      -- Same ordering key as the correlated subquery this replaces, evaluated
      -- in the scan the outer aggregate is ALREADY doing. The trailing
      -- UPPER(wmc.tier) is the new deterministic tiebreak for the ELSE 6 class.
      -- FILTER reproduces the old `t.tier IS NOT NULL`, and an all-NULL group
      -- yields NULL[1] = NULL exactly as an empty subquery did.
      (array_agg(UPPER(wmc.tier) ORDER BY
        CASE UPPER(wmc.tier)
          WHEN 'ULTIMATE'  THEN 1
          WHEN 'LEGENDARY' THEN 2
          WHEN 'RARE'      THEN 3
          WHEN 'FANDOM'    THEN 4
          WHEN 'COMMON'    THEN 5
          ELSE 6
        END, UPPER(wmc.tier))
       FILTER (WHERE wmc.tier IS NOT NULL))[1] AS top_tier
    FROM public.wallet_moments_cache wmc
    WHERE wmc.wallet_address = p_wallet_addr
    GROUP BY wmc.collection_id
  )
  UPDATE public.saved_wallets sw
  SET
    cached_moment_count = agg.moment_count,
    cached_fmv_usd      = CASE WHEN agg.fmv_sum > 0 THEN agg.fmv_sum ELSE NULL END,
    cached_top_tier     = agg.top_tier,
    cache_updated_at    = NOW()
  FROM agg
  WHERE sw.user_id       = p_user_id
    AND sw.wallet_addr   = p_wallet_addr
    AND sw.collection_id = agg.collection_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
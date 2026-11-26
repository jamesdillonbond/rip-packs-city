-- audit_20261126_saved_wallet_stats_ufc_aptos_tier_cast
--
-- 2026-11-26 ~11:50 AM PT (Claude Code cloud). HOTFIX for 20261126194428: its UNION ALL put
-- wallet_moments_cache.tier (text) beside editions.tier (tier_type), and every call of
-- aggregate_saved_wallet_stats raised 42804 "UNION types text and tier_type cannot be matched" —
-- for EVERY wallet, not just UFC, because the branch is planned whether it returns rows or not.
-- Found on the first call after the apply (no sweep had run yet: jobid 259 runs at :44). The only
-- change is e.tier::text. Revert: not to 20261126194428 (broken); re-apply the pre-11-26 body
-- quoted in the ledger entry for 20261126194428.
--
-- anon-exec: unchanged (aggregate_saved_wallet_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.

CREATE OR REPLACE FUNCTION public.aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- AUTHZ: caller must be the user they claim to be (service_role bypasses)
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH items AS (
    SELECT wmc.collection_id, wmc.fmv_usd, wmc.tier, efc.confidence,
           efc.edition_id AS efc_edition_id, efc.fmv_usd AS efc_fmv_usd
      FROM public.wallet_moments_cache wmc
      LEFT JOIN public.editions e
        ON e.external_id = wmc.edition_key
       AND e.collection_id = wmc.collection_id
      LEFT JOIN public.edition_fmv_current efc
        ON efc.edition_id = e.id
     WHERE wmc.wallet_address = p_wallet_addr
    UNION ALL
    -- 2026-11-26: UFC Strike Moments on Aptos accounts linked to this Flow address, valued
    -- at the edition's current FMV exactly as the binder's value tile values them.
    SELECT e.collection_id, efc.fmv_usd, e.tier::text, efc.confidence,
           efc.edition_id, efc.fmv_usd
      FROM public.get_ufc_aptos_holdings_for_flow(p_wallet_addr) h
      JOIN public.editions e ON e.id = h.edition_id
      LEFT JOIN public.edition_fmv_current efc ON efc.edition_id = h.edition_id
  ),
  agg AS (
    SELECT
      i.collection_id,
      COUNT(*) AS moment_count,
      COALESCE(SUM(i.fmv_usd), 0) AS fmv_sum,
      -- Stale split (2026-09-02): latest confidence per edition from edition_fmv_current.
      -- 2026-11-10: a WITHDRAWN price (current row, NULL price) still cached is stale too.
      COALESCE(SUM(i.fmv_usd) FILTER (WHERE i.confidence = 'STALE' OR (i.efc_edition_id IS NOT NULL AND i.efc_fmv_usd IS NULL AND i.fmv_usd IS NOT NULL)), 0) AS fmv_stale_sum,
      COUNT(*) FILTER (WHERE i.confidence = 'STALE' OR (i.efc_edition_id IS NOT NULL AND i.efc_fmv_usd IS NULL AND i.fmv_usd IS NOT NULL)) AS stale_count,
      (array_agg(UPPER(i.tier) ORDER BY
        CASE UPPER(i.tier)
          WHEN 'ULTIMATE'  THEN 1
          WHEN 'LEGENDARY' THEN 2
          WHEN 'RARE'      THEN 3
          WHEN 'FANDOM'    THEN 4
          WHEN 'COMMON'    THEN 5
          ELSE 6
        END, UPPER(i.tier))
       FILTER (WHERE i.tier IS NOT NULL))[1] AS top_tier
    FROM items i
    GROUP BY i.collection_id
  )
  UPDATE public.saved_wallets sw
  SET
    cached_moment_count  = agg.moment_count,
    cached_fmv_usd       = CASE WHEN agg.fmv_sum > 0 THEN agg.fmv_sum ELSE NULL END,
    cached_fmv_stale_usd = CASE WHEN agg.fmv_stale_sum > 0 THEN agg.fmv_stale_sum ELSE NULL END,
    cached_stale_count   = agg.stale_count,
    cached_top_tier      = agg.top_tier,
    cache_updated_at     = NOW()
  FROM agg
  WHERE sw.user_id       = p_user_id
    AND sw.wallet_addr   = p_wallet_addr
    AND sw.collection_id = agg.collection_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

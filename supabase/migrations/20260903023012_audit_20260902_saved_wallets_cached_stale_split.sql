-- audit_20260902_saved_wallets_cached_stale_split
--
-- WHAT IS WRONG. The public profile, its OG card and the share tweet publish
-- `saved_wallets.cached_fmv_usd` summed flat — a number that INCLUDES
-- stale-priced Moments — while the dashboard the same collector just looked at
-- holds stale value out of the headline (`get_wallet_collection_stats` splits
-- `fmv_total` / `fmv_stale_total`; `lib/dashboard/aggregate.ts` sums only the
-- former). Measured 2026-09-02 on wallet 0xbd94cade097e50ac: dashboard
-- "$48,872 + $39,553 across 370 stale-priced", public profile / OG / tweet
-- "$88.4K". A collector who posts the campaign link posts a number 80% higher
-- than the one their own dashboard shows (onboarding QA handoff, finding #6).
--
-- WHY HERE. `saved_wallets` carries no confidence split, so no consumer of the
-- public payload CAN make one. `wallet_moments_cache.fmv_confidence` exists but
-- is a stale denorm (302 rows / $11,665 STALE on that wallet vs 371 / $39,553
-- from `edition_fmv_current`, which matches the live RPC exactly) — a denorm
-- cannot heal its source, so it is not used. `edition_fmv_current` is a table
-- keyed by edition uuid; joining it through `editions(external_id,
-- collection_id)` reproduces the dashboard's definition.
--
-- COST, MEASURED (EXPLAIN BUFFERS, warm):
--   0x4d82b07c10f1fe0f (355 rows, 2 collections): the split query is
--     hit=2573 read=262 vs the 08-28 aggregate's hit=196 read=166 — nested-loop
--     index lookups on editions_external_id_collection_id_key +
--     edition_fmv_current_pkey, ~100 ms.
--   0xbd94cade097e50ac (19,383 rows, 5 collections): hit=18286 read=1389 vs a
--     14.8k-buffer wmc scan alone — the planner switches to two hash joins,
--     ~335 ms.
--   The caller population is 23 wallets, reconciled hourly by
--   `reconcile_all_saved_wallet_stats(10, 40, 360)` (48 h to 2026-09-02:
--   46/48 ok, avg 2.9 s, max 16.9 s) plus the after() of wallet association.
--   ⚠ This deliberately spends some of the headroom the 08-28 migration won.
--   Falsifier: `reconcile-saved-wallet-stats` ok-rate over the next 48 h falls
--   below the 46/48 baseline, or `elapsed_ms` per wallet doubles — then revert
--   the function body (below) and keep the columns.
--
-- CONTRACT KEPT. `cached_fmv_usd` stays the TOTAL (incl. stale) — cost-basis,
-- collection-breakdown and tier-breakdown routes read it — and the two NEW
-- columns carry the stale portion. Consumers that want the dashboard's
-- headline compute `cached_fmv_usd - cached_fmv_stale_usd`.
--
-- anon-exec: intentional — CREATE OR REPLACE with the same signature; ACL preserved (SECURITY DEFINER, anon and authenticated EXECUTE both false, verified live 2026-09-02 before and after) (aggregate_saved_wallet_stats)
--
-- REVERT (function): re-apply the body from
--   20260828225925_audit_20260828_aggregate_saved_wallet_stats_drop_correlated_tier_subquery.sql
-- REVERT (columns): ALTER TABLE public.saved_wallets DROP COLUMN cached_fmv_stale_usd, DROP COLUMN cached_stale_count;
--   (drop the code readers first — lib/profile/public-profile.ts and app/api/og/profile.)

ALTER TABLE public.saved_wallets
  ADD COLUMN IF NOT EXISTS cached_fmv_stale_usd numeric,
  ADD COLUMN IF NOT EXISTS cached_stale_count integer;

COMMENT ON COLUMN public.saved_wallets.cached_fmv_stale_usd IS
  'Portion of cached_fmv_usd whose latest FMV confidence is STALE (edition_fmv_current). Headline = cached_fmv_usd - this. Written by aggregate_saved_wallet_stats.';
COMMENT ON COLUMN public.saved_wallets.cached_stale_count IS
  'Moments in this (wallet, collection) row whose latest FMV confidence is STALE. Written by aggregate_saved_wallet_stats.';

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

  WITH agg AS (
    SELECT
      wmc.collection_id,
      COUNT(*) AS moment_count,
      COALESCE(SUM(wmc.fmv_usd), 0) AS fmv_sum,
      -- Stale split (2026-09-02): the same definition the dashboard's
      -- get_wallet_collection_stats uses — latest confidence per edition,
      -- read from the edition_fmv_current table rather than fmv_snapshots.
      COALESCE(SUM(wmc.fmv_usd) FILTER (WHERE efc.confidence = 'STALE'), 0) AS fmv_stale_sum,
      COUNT(*) FILTER (WHERE efc.confidence = 'STALE') AS stale_count,
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
    LEFT JOIN public.editions e
      ON e.external_id = wmc.edition_key
     AND e.collection_id = wmc.collection_id
    LEFT JOIN public.edition_fmv_current efc
      ON efc.edition_id = e.id
    WHERE wmc.wallet_address = p_wallet_addr
    GROUP BY wmc.collection_id
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

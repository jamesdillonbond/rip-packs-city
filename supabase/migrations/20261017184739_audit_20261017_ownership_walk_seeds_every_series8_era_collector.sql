-- audit_20261017_ownership_walk_seeds_every_series8_era_collector
-- One-off: seed every Top Shot wallet that bought on the marketplace or opened a pack since
-- the Series 8 era began (2025-09-01) and that the ownership index has never seen.
-- WHY (2026-10-17 11:50 AM PT). seed_topshot_ownership_walk_candidates only looks back
-- 60 days, so a collector who has held Series 8 Moments since last season but has not
-- traded or ripped since mid-August is never walked. Those holders are what keep newly
-- indexed sets below the 98 % census gate (average coverage of new-set editions 52.7 % on
-- 10-17). Measured: 15,454 distinct such wallets, 7,455 in neither topshot_ownership nor
-- the candidate table.
-- COST. get_stale_ownership_wallets sorts never-walked candidates first (-infinity), so the
-- walk (~800 wallets/run, ~8 runs/day) spends ~1.2 days on them before its normal
-- re-confirmation rotation resumes; done before the 2026-10-20 Series 2026-27 tip-off.
-- Ids they hold that no source can place go to the unmapped queue; the neighbour predictor
-- skips the Series 8 Base Set ones.
-- REVERT (operator, SQL editor): remove the topshot_ownership_walk_candidates rows with
--   source = 'series8_era_backfill' AND last_walked_at IS NULL (only rows this inserted that
--   were never walked; walked ones are harmless and age into the normal rotation).
INSERT INTO public.topshot_ownership_walk_candidates (owner_address, source)
SELECT u.a, 'series8_era_backfill'
  FROM (SELECT lower(s.buyer_address) AS a
          FROM public.sales s
         WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
           AND s.sold_at > '2025-09-01' AND s.buyer_address IS NOT NULL
        UNION
        SELECT lower(r.opener_address)
          FROM public.pack_rips r
         WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
           AND r.sealed_at > '2025-09-01') u
 WHERE u.a ~ '^0x[0-9a-f]{16}$'
   AND NOT EXISTS (SELECT 1 FROM public.topshot_ownership o WHERE o.owner_address = u.a)
ON CONFLICT (owner_address) DO NOTHING;

-- Records in migration history a DROP that Cowork ran ad hoc on 2026-09-29.
-- 20260929164033_audit_20260929_add_wmc_null_hydrate_feeder created
-- topshot_moment_hydrate_dispatch_wmc_nulls(int); its 40-row test returned 40/40 no_nft
-- (the wallets do not hold those moments), so it was the wrong mechanism and was dropped.
-- No-op on production (the function is already gone); keeps a replay of the repo equal to prod.
DROP FUNCTION IF EXISTS public.topshot_moment_hydrate_dispatch_wmc_nulls(integer);

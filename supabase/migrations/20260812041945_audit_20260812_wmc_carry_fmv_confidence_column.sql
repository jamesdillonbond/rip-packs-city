-- Carry the FMV confidence label onto wallet_moments_cache alongside the
-- denormalized fmv_usd.
--
-- WHY: fmv_current carries `confidence`; wmc did not. wmc is the portfolio
-- store, and 34 DB functions sum wmc.fmv_usd, so the staleness/quality marker
-- was structurally unavailable at the exact point a portfolio total is
-- computed. get_wallet_collection_snapshot (behind the anon-public
-- /share/[wallet]) emitted per-collection `fmv` with no confidence field at
-- all, so a 2-year-old print rendered as current value with no marker.
-- Measured on LaLiga Golazos: $167,420.50 across 177 copies / 10 wallets / 28
-- editions whose latest snapshot is STALE — up to 80% of a single wallet's
-- entire displayed Golazos total.
--
-- Nullable, NO default and NO index on purpose:
--   * a nullable column with no default is metadata-only in PG11+ (instant,
--     no table rewrite) — this table is 2,325 MB / 2.22M rows.
--   * indexing it (or using it as an index predicate/INCLUDE column) would
--     block HOT updates on a table the wallet-backfill writers rewrite
--     constantly. Consumers filter by wallet, never by confidence.
--
-- Type matches pinnacle_catalog.fmv_confidence (the same public.fmv_confidence
-- enum: HIGH, MEDIUM, LOW, ASK_ONLY, SALES_ONLY, STALE, NO_DATA).
--
-- Backfill is deliberately NOT done here. populate_wmc_fmv_from_snapshots
-- writes it going forward; historical rows are filled per-collection via the
-- p_force path, which the route documents as "reserved for ad-hoc
-- remediation, not the cron".
--
-- Revert: ALTER TABLE public.wallet_moments_cache DROP COLUMN fmv_confidence;

SET LOCAL lock_timeout = '15s';

ALTER TABLE public.wallet_moments_cache
  ADD COLUMN IF NOT EXISTS fmv_confidence public.fmv_confidence;

COMMENT ON COLUMN public.wallet_moments_cache.fmv_confidence IS
  'Confidence of the fmv_snapshots row that fmv_usd was denormalized from. Written by populate_wmc_fmv_from_snapshots, paired with the SAME snapshot the value came from (never the latest snapshot independently) so the label always describes the number actually shown. NULL = not yet backfilled, not "unknown quality". Deliberately unindexed to preserve HOT updates.';

-- audit_20260802_golazos_wmc_edition_key_recovery_from_sales
--
-- CAUSE
-- ─────
-- 9,494 of 9,502 (99.9%) LaLiga Golazos `wallet_moments_cache` rows across
-- 115 wallets carry NULL edition_key, and therefore NULL serial_number /
-- tier / set_name / player_name / mint_count / image_url. A Golazos wallet
-- renders as a list of empty shells.
--
-- ROOT CAUSE (measured -- and it is NOT "the writer is still broken")
-- ──────────────────────────────────────────────────────────────────
-- The WRITER was already fixed on 2026-07-31: app/api/wallet-backfill-golazos
-- was moved off runIdOnlyBackfill (which writes edition_key: null by design)
-- onto runAllDayDetailsBackfill, which writes edition_key + serial_number.
-- That fix works -- the 8 Golazos rows created since (2026-08-01/02) are
-- fully enriched.
--
-- The reason the other 9,494 never healed is a SECOND, separate defect in
-- lib/chains/flow/wallet-backfill-helpers.ts: runAllDayDetailsBackfill loads
-- the wallet's cached ids with loadCachedMomentIds() -- a PRESENCE-ONLY Set --
-- and then does
--     if (skipCached && cachedIds.has(nftId)) { skippedCount++; continue }
-- Because seed-wallet-refresh -> wallet-backfill-multicollection dispatches
-- with skip_cached: true, every one of the 9,494 pre-existing empty shells is
-- skipped on every cron tick, forever. Only moments acquired AFTER the 07-31
-- fix are ever enriched. (The sibling paginated runner already gets this
-- right -- it uses loadCachedMomentIdsAndKeys(), a Map<moment_id, has_key>,
-- and skips only rows that are already enriched.) The code fix ships
-- alongside this migration; this migration recovers the stranded history that
-- a re-walk would otherwise have to wait for.
--
-- CORRECTION TO A PRIOR CLAIM
-- ───────────────────────────
-- The 2026-07-31 header comment on wallet-backfill-golazos states that "only
-- 0.0% of these rows were recoverable" from existing data. That measurement
-- was taken against `public.moments` ONLY, which does indeed hold ZERO
-- Golazos rows. It does not generalise: `public.sales` resolves 4,796 of the
-- 9,494 stranded moment_ids (50.5%) -- and does so UNAMBIGUOUSLY.
--
-- EVIDENCE
-- ────────
--   stranded Golazos moment_ids (edition_key IS NULL) ...... 9,494
--   resolvable via public.sales (nft_id -> edition_id) ...... 4,796 (50.5%)
--     ... with >1 distinct edition_id (ambiguous) ........... 0
--     ... with >1 distinct serial_number (ambiguous) ........ 0
--     ... with no serial_number at all ..................... 0
--   resolvable via public.moments .......................... 0 (0.0%)
--   resolvable via cached_listings_v2 ...................... 164 (subset)
-- A sale of NFT X is always a sale of exactly one edition, and an NFT's
-- edition never changes, so this mapping is sound. The zero-ambiguity counts
-- above were verified live before this migration was written.
--
-- The remaining ~4,698 rows have never transacted on an indexed marketplace
-- and are only recoverable by an on-chain re-walk -- which the accompanying
-- code fix enables on the next scheduled tick.
--
-- SAFETY
-- ──────
-- Fills NULLs only (WHERE w.edition_key IS NULL) -- cannot overwrite a good
-- value. The HAVING guard makes the source unambiguous by construction, so
-- the migration is safe to re-run. Planner check before running (EXPLAIN, no
-- ANALYZE): index scans over the 7 sales partitions' collection_id indexes,
-- then an index probe into idx_wmc_moment_collection_cover -- cost 62,475,
-- NO sequential scan of the 2.36 GB wallet_moments_cache table.
--
-- REVERT
-- ──────
--   UPDATE public.wallet_moments_cache w
--      SET edition_key = NULL, serial_number = NULL, tier = NULL,
--          set_name = NULL, player_name = NULL, team_name = NULL,
--          mint_count = NULL, image_url = NULL
--     FROM public.audit_20260802_golazos_wmc_key_recovery a
--    WHERE w.id = a.wmc_id;
--   DROP TABLE public.audit_20260802_golazos_wmc_key_recovery;
-- (Every row touched here was fully NULL on all of those columns
--  beforehand -- that is the defect being repaired -- so the revert restores
--  the exact pre-state.)

-- 1. Snapshot which rows this migration will touch.
CREATE TABLE IF NOT EXISTS public.audit_20260802_golazos_wmc_key_recovery (
  wmc_id      uuid PRIMARY KEY,
  moment_id   text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_20260802_golazos_wmc_key_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260802_golazos_wmc_key_recovery FROM PUBLIC, anon, authenticated;

INSERT INTO public.audit_20260802_golazos_wmc_key_recovery (wmc_id, moment_id)
SELECT w.id, w.moment_id
  FROM public.wallet_moments_cache w
 WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
   AND w.edition_key IS NULL
   AND EXISTS (
     SELECT 1 FROM public.sales sa
      WHERE sa.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
        AND sa.nft_id = w.moment_id
        AND sa.edition_id IS NOT NULL
   )
ON CONFLICT (wmc_id) DO NOTHING;

-- 2. Recover edition_key (+ serial_number where unambiguous) from sales.
UPDATE public.wallet_moments_cache w
   SET edition_key   = s.ext,
       serial_number = COALESCE(w.serial_number, s.ser)
  FROM (
    SELECT sa.nft_id                       AS nft_id,
           min(e.external_id)              AS ext,
           CASE WHEN count(DISTINCT sa.serial_number) = 1
                THEN min(sa.serial_number) END AS ser
      FROM public.sales sa
      JOIN public.editions e ON e.id = sa.edition_id
     WHERE sa.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
       AND sa.edition_id IS NOT NULL
     GROUP BY sa.nft_id
    HAVING count(DISTINCT sa.edition_id) = 1   -- unambiguous edition only
  ) s
 WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
   AND w.edition_key IS NULL
   AND w.moment_id = s.nft_id;

-- 3. Now that edition_key exists, run the existing collection-agnostic,
--    COALESCE-guarded metadata denorm (tier / player_name / set_name /
--    mint_count / team_name) and the image denorm.
SELECT public.backfill_wmc_metadata_from_editions(
  NULL, '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
);

SELECT public.populate_wmc_image(
  '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid, false, 50000
);
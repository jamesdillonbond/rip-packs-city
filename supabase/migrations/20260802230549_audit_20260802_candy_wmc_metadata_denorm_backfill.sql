-- audit_20260802_candy_wmc_metadata_denorm_backfill
--
-- CAUSE
-- ─────
-- 18,932 of 25,375 (74.6%) Candy MLB `wallet_moments_cache` rows carry NULL
-- tier / set_name / mint_count / player_name. `/insights/candy-mlb` has been
-- PUBLIC since 2026-07-31, so a Candy holder's portfolio renders unlabelled.
--
-- ROOT CAUSE (measured, not hypothesised)
-- ───────────────────────────────────────
-- NOT a regression and NOT a re-NULLing writer. Neither Candy wmc writer has
-- EVER run the metadata post-pass that every Flow wallet backfill runs:
--   * app/api/ingest/candy-editions/route.ts  (daily DAS group-walk)
--   * app/api/wallet-backfill-candy/route.ts  (per-wallet DAS walk)
-- Both build their payload from lib/chains/solana/normalize.ts:normalizeSerial(),
-- which emits exactly 6 columns (wallet_address, collection_id, moment_id,
-- edition_key, serial_number, image_url) and then upserts DIRECTLY to the
-- table -- never calling backfill_wmc_metadata_from_editions() the way
-- runAllDayDetailsBackfill()/runPinnacleDetailsBackfill() do. The 6,443 rows
-- that ARE enriched were filled by the one-off 2026-07-19 parity denorm;
-- every row created after that date has been NULL ever since (enriched rows
-- min(created_at) 2026-07-17, NULL rows min(created_at) 2026-07-19).
--
-- The `set_name` re-NULLing bug fixed on 2026-08-01 was on `editions`, a
-- DIFFERENT table, and does NOT extend to wmc: because tier/set_name/
-- mint_count/player_name are absent from the upsert payload, PostgREST's
-- ON CONFLICT DO UPDATE never touches them. Verified empirically -- all
-- 25,375 rows were re-upserted by the daily tick at 2026-08-02 08:40Z and
-- all 6,443 already-enriched rows RETAINED their tier. This backfill is
-- therefore durable, not theatre.
--
-- EVIDENCE
-- ────────
--   total candy wmc rows ................................. 25,375
--   NULL tier / set_name / mint_count / player_name ...... 18,932 (74.6%)
--   joinable to editions on external_id = edition_key .... 25,375 (100%)
--   of the 18,932 NULL rows, fixable from editions:
--     tier 18,932 | set_name 18,932 | mint_count 18,932 | player_name 18,932
--   => 100% of the gap is closable by the existing JOIN. No new data needed.
--
-- WHAT THIS DOES
-- ──────────────
-- Snapshots the affected row ids, then calls the EXISTING, drift-guarded
-- SECURITY DEFINER function backfill_wmc_metadata_from_editions() scoped to
-- the Candy collection. That function is collection-agnostic and COALESCE-
-- guarded (it only ever fills a NULL; it can never overwrite a good value),
-- so no new pricing/labelling logic is introduced here.
--
-- Planner check before running (EXPLAIN, no ANALYZE): Nested Loop driven by
-- idx_editions_collection (125 Candy editions) probing
-- idx_wmc_coll_ek_serial_cover -- total cost 518. No sequential scan of the
-- 2.36 GB wallet_moments_cache table.
--
-- REVERT
-- ──────
--   UPDATE public.wallet_moments_cache w
--      SET tier = NULL, set_name = NULL, mint_count = NULL,
--          player_name = NULL, team_name = NULL
--     FROM public.audit_20260802_candy_wmc_metadata_backfill a
--    WHERE w.id = a.wmc_id;
--   DROP TABLE public.audit_20260802_candy_wmc_metadata_backfill;
-- (The audit table stores the exact pre-state, so the revert restores it
--  precisely rather than blanket-nulling.)

-- 1. Snapshot the pre-state of every row this backfill will touch.
CREATE TABLE IF NOT EXISTS public.audit_20260802_candy_wmc_metadata_backfill (
  wmc_id           uuid PRIMARY KEY,
  old_tier         text,
  old_set_name     text,
  old_mint_count   integer,
  old_player_name  text,
  old_team_name    text,
  captured_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_20260802_candy_wmc_metadata_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260802_candy_wmc_metadata_backfill FROM PUBLIC, anon, authenticated;

INSERT INTO public.audit_20260802_candy_wmc_metadata_backfill
  (wmc_id, old_tier, old_set_name, old_mint_count, old_player_name, old_team_name)
SELECT w.id, w.tier, w.set_name, w.mint_count, w.player_name, w.team_name
  FROM public.wallet_moments_cache w
 WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   AND w.edition_key IS NOT NULL
   AND (w.tier IS NULL OR w.player_name IS NULL OR w.set_name IS NULL
        OR w.mint_count IS NULL OR w.team_name IS NULL)
ON CONFLICT (wmc_id) DO NOTHING;

-- 2. Fill via the existing collection-agnostic, COALESCE-guarded denorm.
SELECT public.backfill_wmc_metadata_from_editions(
  NULL, '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
);
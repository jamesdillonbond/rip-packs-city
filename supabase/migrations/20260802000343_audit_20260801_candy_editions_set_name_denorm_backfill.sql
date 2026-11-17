-- audit_20260801_candy_editions_set_name_denorm_backfill
--
-- REPO RECORD of a migration APPLIED TO PROD VIA MCP on 2026-08-02 00:03:43Z
-- with no committed file. Recorded here so the change has a reviewable revert
-- path (CLAUDE.md: MCP-applied-with-no-committed-migration is the documented
-- "unpinnable / invisible to the drift guard" gap).
--
-- NOTE ON THE DUPLICATE: a concurrent session applied a second, functionally
-- identical fill-only UPDATE 20 minutes later as
-- `audit_20260801_candy_editions_set_name_denorm` (version 20260802002403).
-- Both are idempotent and scoped `WHERE set_name IS NULL`, so the re-apply was
-- a harmless no-op. Only this (fully documented) one is kept as the repo file.
--
-- CAUSE
--   editions.set_name was NULL on 125/125 candy_mlb rows while set_id was
--   populated on all 125 and the single joined sets row
--   ('2026 MLB Base Series ICONs') carries a populated name.
--
--   ROOT CAUSE is NOT a one-time miss: lib/chains/solana/normalize.ts
--   normalizeEdition() hardcoded `set_name: null` INSIDE the upsert payload,
--   and /api/ingest/candy-editions upserts that payload daily with
--   onConflict "external_id,collection_id". Because the key is PRESENT in the
--   payload, every run actively re-NULLed the column, so a bare UPDATE would
--   have re-rotted within 24h. The companion code change drops set_name from
--   the payload entirely (matching how the same function already omits set_id,
--   which is precisely why set_id survived the daily upsert and set_name did
--   not), so this backfill is stable.
--
-- EVIDENCE (before) total=125 has_set_id=125 has_set_name=0
-- VERIFIED (after, 2026-08-02) total=125 has_set_id=125 has_set_name=125
--
-- SCOPE candy_mlb only, fill-only (`AND e.set_name IS NULL`) so it can never
-- overwrite an existing value. The 307 nba_top_shot rows in the same state are
-- deliberately NOT touched (different, unverified cause).
--
-- REVERT (exact):
--   UPDATE public.editions SET set_name = NULL
--    WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713';

UPDATE public.editions e
SET set_name = s.name,
    updated_at = now()
FROM public.sets s
WHERE s.id = e.set_id
  AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  AND e.set_name IS NULL
  AND s.name IS NOT NULL;

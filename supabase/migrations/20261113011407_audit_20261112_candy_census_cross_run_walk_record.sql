-- audit_20261112_candy_census_cross_run_walk_record
--
-- 2026-11-12 ~5:30 PM PT (Claude Code cloud; Trevor: "Keep going"). The census RETIRE step (af8a129ad /
-- cc0a68019) only ran after a walk that started and finished in ONE run, so a collection whose walk spans runs
-- (2022 Leadoff ICONs, ~370k cards, 4 runs) could never retire the holdings rows DAS stopped returning — its 8
-- label-less editions stayed. These columns carry the walk's record across runs:
--   census_walk_tracked         true from a walk's first page under the new code; a walk resumed from before
--                               it reads false and retires nothing (fails open)
--   census_walk_labelless_seen  the LABEL-LESS edition keys a card of this walk resolved to (small)
--   census_walk_skipped         cards the walk skipped (any > 0 → no retire); +1 when the record read failed
--   census_walk_cards           cards walked so far (sizes RETIRE's cap for the whole walk)
-- All reset when the walk completes. Additive, defaulted, read only by lib/candy/collections-census.ts.
--
-- REVERT: ALTER TABLE public.candy_collections DROP COLUMN census_walk_tracked, DROP COLUMN census_walk_labelless_seen,
--   DROP COLUMN census_walk_skipped, DROP COLUMN census_walk_cards; — only AFTER reverting the commit titled
--   "candy census: cross-run walk record, lock retry; wallet refresh keeps metadata-less cards" (it selects them).

ALTER TABLE public.candy_collections
  ADD COLUMN IF NOT EXISTS census_walk_tracked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS census_walk_labelless_seen text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS census_walk_skipped integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS census_walk_cards integer NOT NULL DEFAULT 0;

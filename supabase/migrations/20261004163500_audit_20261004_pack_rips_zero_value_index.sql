-- audit_20261004_pack_rips_zero_value_index
--
-- 2026-10-04 ~9:30 AM PT (Claude Code, Trevor's box). `backfill-pack-rip-metadata` timed out at
-- its 50 s statement_timeout on 5 of 24 runs (10-03 9:53/10:53 PM, 10-04 5:53/6:53/7:53 AM PT),
-- and its successful runs have been climbing: avg 28.7 s (10-01) -> 31.3 -> 35.2 -> 40.7 s (10-04).
--
-- MEASURED. The `zero_repair` leg of backfill_pack_rip_metadata,
--   WHERE pr.pull_value_usd = 0 ORDER BY pr.metadata_updated_at ASC LIMIT n,
-- costs 14.6 s and 46,016 buffers (43,035 read) for ZERO rows: the #128 zero drain is finished
-- (count(pull_value_usd = 0) = 0), and with no index for the predicate the planner bitmap-scans
-- all 371 k valued rips (idx_pack_rips_stale_valued) to prove there are none. The cost GREW as
-- the drain finished, because a LIMIT over a shrinking match set must read further to fill or
-- to give up.
--
-- FIX. A partial index matching the leg's predicate and ORDER BY. It is empty today (0 rows) and
-- stays tiny, so the leg answers "none" by reading one empty index page. Any zero that ever
-- reappears is still found, oldest-stamp-first. No function change.
--
-- NOT FIXED HERE (filed): the `unpriced_retry` leg (7.9 s / 800 k buffers for 85 rows). Rips
-- with no moment_acquisitions are never selected, so their stamp never moves and they pile up at
-- the head of idx_pack_rips_unvalued_stamped.
--
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_pack_rips_zero_value;

CREATE INDEX IF NOT EXISTS idx_pack_rips_zero_value
  ON public.pack_rips USING btree (metadata_updated_at)
  WHERE (pull_value_usd = (0)::numeric);

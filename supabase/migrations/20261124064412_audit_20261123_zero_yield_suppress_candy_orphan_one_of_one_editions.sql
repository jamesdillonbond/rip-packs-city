-- audit_20261123_zero_yield_suppress_candy_orphan_one_of_one_editions
--
-- 2026-11-23 ~10:55 PM PT (Claude Code, Trevor's laptop; Trevor: "Keep going").
--
-- The Sentinel reads WARN on one Zero-Yield lane: candy-orphan-one-of-one-editions (174 runs, last find 11-16).
-- It is a DRAINED CLEANUP, not a stall: it deletes Candy circulation-1 editions no card holds (left behind when the
-- 11-09 census re-keyed every 1/1 card by its own asset id; ledger 2026-11-09). It deleted the backlog 11-09..11-16
-- and has had nothing to delete since. Measured against its OWN predicate (live function unchanged):
--   10,970 Candy 1/1 editions; 2 unheld, 0 of them younger than the 1-day gate, and BOTH referenced by a guarded
--   table (wishlist / watchlist / offer / pack pool / special serial), which the function skips by design.
-- Same pattern and precedent as candy-orphan-name-only-editions (suppressed 2026-11-20).
--
-- REVERT: DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'candy-orphan-one-of-one-editions';

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_at, added_by)
VALUES (
  'candy-orphan-one-of-one-editions',
  'DRAINED CLEANUP, measured 2026-11-23 ~10:50 PM PT. It deletes Candy circulation-1 editions no card holds (left by the 11-09 census re-key of every 1/1 card by asset id); it cleared that backlog 11-09..11-16 and has found nothing since (174 runs). Independent count on its own predicate: 10,970 Candy 1/1 editions, 2 unheld, 0 inside the 1-day gate, and both unheld ones are referenced by a guarded table (wishlist/watchlist/offer/pack pool/special serial), which it skips by design. Positive control: its 11-09 runs deleted 19/25/1/7/45/58 with the same predicate. RE-CHECK CONDITION: remove this row if the count of Candy circulation_count = 1 editions with no wallet_moments_cache holder, older than 1 day, and no guarded reference rises above 0 while the lane keeps reporting candidates 0 (a broken lane), or if another census re-key is run (new orphans expected).',
  now(),
  'claude-code local session (Trevor: "Keep going")'
)
ON CONFLICT (pipeline) DO NOTHING;

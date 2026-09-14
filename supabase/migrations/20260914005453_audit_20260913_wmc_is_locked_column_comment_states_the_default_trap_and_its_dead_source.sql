-- The column comment is the first thing anyone inspecting this column reads, and
-- it was wrong in two ways that together ARE register #112:
--
--   1. It said "from GQL isLocked field". That source -- public-api.nbatopshot.com
--      -- has been DECOMMISSIONED since ~2026-08-30 (530, re-verified 09-13 from a
--      residential IP). Anyone trusting the comment would look for a live feed
--      that does not exist.
--   2. It said nothing about the DEFAULT. The column is `DEFAULT false` and
--      NULLABLE, and 1,160,468 of 1,767,936 Top Shot rows have never been
--      checked, with is_locked = true on EXACTLY ZERO of them.
--
-- ⭐ The never-checked fact was ALREADY documented -- on lock_checked_at, the
-- SIBLING column, where nobody reading is_locked would ever see it. That is the
-- provenance-stripping of #112 reproduced in the documentation layer, and it is
-- why this is worth a migration rather than a note in the register: a comment
-- travels with the column into every `\d+`, every schema dump, and
-- docs/reference/schema-truth.md.
--
-- ⚠ Comments only. No data, no DDL on the column itself, no behaviour change.
-- REVERT: restore the previous two COMMENT ON statements (the old is_locked text
-- was 'Whether moment is locked on Top Shot (from GQL isLocked field)'; the old
-- lock_checked_at text is preserved almost verbatim inside the new one).

COMMENT ON COLUMN public.wallet_moments_cache.is_locked IS
'Whether the moment is locked (cannot be listed/traded). ⛔ READ lock_checked_at BEFORE TRUSTING THIS: the column is DEFAULT false and nullable, so `false` means EITHER "checked, not locked" OR "nobody ever looked". Measured 2026-09-13 whole-table: 1,160,468 of 1,767,936 Top Shot rows have lock_checked_at NULL, with is_locked = true on EXACTLY ZERO of them -- the perfect correlation proving that false is the default, not a reading. Among rows actually checked, 44.0% ARE locked, so the default is not a benign approximation. Coverage differs sharply by collection (09-13: all_day 99.6% checked, pinnacle 100%, top_shot 34.4%, candy/golazos/ufc 0%). Consumers must gate on provenance: get_wallet_moments_with_fmv and get_wallet_summary both project `lock_known` = (lock_checked_at IS NOT NULL), and every user-facing surface reports a third UNKNOWN state rather than folding it into "unlocked" -- see register #112. ⚠ The old comment said "from GQL isLocked field"; that source (public-api.nbatopshot.com) is DECOMMISSIONED. Writers today are the on-chain Cadence lock-check lane (apply_lock_check_batch) and the on-view refresh.';

COMMENT ON COLUMN public.wallet_moments_cache.lock_checked_at IS
'On-chain lock re-check watermark, stamped by apply_lock_check_batch. ⭐ THIS COLUMN IS THE PROVENANCE FOR is_locked: NULL means nobody ever checked, and a NULL here with is_locked = false is the column DEFAULT rather than a measurement (register #112). Genuinely oversubscribed against the MAX_AGE_DAYS=7 target in app/api/cron/lock-check-batch/route.ts, and that constant is a documented BACKGROUND TARGET, not a promise -- an old value here IS a real staleness signal, just an expected one. Backlog is converging but is a MOVING FLOOR, not a draining queue (never-checked Top Shot rows: 1,510,216 on 09-02 -> 1,160,468 on 09-13, ~31,800/day net, while new wallets keep arriving). ⚠ Since 2026-09-13 the honesty of every surface rests on this column: get_wallet_moments_with_fmv and get_wallet_summary project `lock_known` = (lock_checked_at IS NOT NULL), and consumers render a third UNKNOWN state. Dropping or stopping this stamp silently re-enables the false claim.';

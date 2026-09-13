-- audit_20260913_wallet_moments_carry_lock_provenance_and_pinnacle_stops_discarding_its_locks
--
-- ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
-- `get_wallet_moments_with_fmv` is the single source for /api/portfolio-export,
-- /api/collection-moments and /api/analytics. It hands each of them a BARE
-- boolean `is_locked` with its provenance removed, so none of them CAN tell a
-- measured "not locked" from a value nobody ever read. Two distinct defects:
--
-- 1. REGISTER #112 — `wallet_moments_cache.is_locked` has `column_default
--    false`, and 1,160,468 of 1,767,936 Top Shot rows have `lock_checked_at`
--    NULL, with `is_locked = true` on EXACTLY ZERO of them (the perfect
--    correlation is the proof it is the default, not a reading). Candy MLB,
--    Golazos and UFC Strike are 0% checked across a further 39,357 rows. The
--    function then COALESCEs that nullable column to `false` a second time —
--    the repo's `?? 0` fabricated-value shape, in SQL.
--    Downstream this is not academic: /api/analytics does
--    `if (locked) {...} else { unlockedCount++; unlockedFmv += fmv }`, a binary
--    else, so every unchecked moment is counted as UNLOCKED and its FMV added
--    to the user's sellable total. A locked Moment cannot be sold.
--
-- 2. ⭐ DISNEY PINNACLE IS WORSE AND WAS NOT KNOWN. The `base_pinnacle` branch
--    hardcodes `false AS is_locked`, ignoring `wmc.is_locked` entirely — while
--    Pinnacle is 100% lock-checked (56,581 of 56,581) with **370 genuinely
--    locked pins**. So those 370 readings exist, are correct, and are thrown
--    away in favour of a literal. This is a false claim on measured data, which
--    is strictly worse than #112's false claim on absent data.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
-- Additively: `lock_known` joins the row payload, true only when the source
-- RECORDS having checked. Existing consumers that never read the key are
-- unaffected, so this can ship ahead of the surface changes without altering
-- what anyone renders today. It also stops the double-COALESCE and lets
-- Pinnacle's real readings through.
--
-- ⚠ NOT a data backfill. Setting `is_locked = NULL WHERE lock_checked_at IS
-- NULL` is deliberately NOT done here: it is 1.2M rows of IO and it would
-- change NOTHING on its own, because `m.is_locked ? "true" : "false"` renders
-- NULL as "false" too. The readers must handle unknown FIRST. See #112.
--
-- ── WHY A TRANSFORM AND NOT A REWRITTEN BODY ────────────────────────────────
-- `CREATE OR REPLACE` is a full-body write, and re-typing 7,747 characters is
-- how a concurrent session's edit gets silently reverted. This reads whatever
-- is LIVE at apply time and makes three guarded replacements, each of which
-- RAISEs unless it matches exactly once — so it cannot clobber an edit it did
-- not anticipate, and it cannot half-apply.
--
-- REVERT: re-run this file's inverse — replace `wmc.is_locked AS is_locked,`
-- with `COALESCE(wmc.is_locked, false) AS is_locked,` in base_other, restore
-- `false AS is_locked,` in base_pinnacle, and drop the two `lock_known` lines.
-- Nothing else changes; no data is written by this migration.

DO $mig$
DECLARE
  v_def  text;
  v_len  int;
  v_hits int;

  c_other_from    CONSTANT text := 'COALESCE(wmc.is_locked, false) AS is_locked,';
  c_other_to      CONSTANT text := 'wmc.is_locked AS is_locked,' || E'\n      (wmc.lock_checked_at IS NOT NULL) AS lock_known,';

  c_pin_from      CONSTANT text := E'\n      false AS is_locked,';
  c_pin_to        CONSTANT text := E'\n      wmc.is_locked AS is_locked,\n      (wmc.lock_checked_at IS NOT NULL) AS lock_known,';

  c_enriched_from CONSTANT text := E'\n      p.is_locked,';
  c_enriched_to   CONSTANT text := E'\n      p.is_locked,\n      p.lock_known,';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wallet_moments_with_fmv';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_wallet_moments_with_fmv() not found — refusing to guess at its body';
  END IF;
  v_len := length(v_def);

  -- 1 ── base_other: a nullable reading stops being COALESCEd to a negative
  --      finding, and carries whether anyone ever looked.
  v_hits := (length(v_def) - length(replace(v_def, c_other_from, ''))) / length(c_other_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'base_other is_locked: expected exactly 1 occurrence, found % — the body has changed, re-derive', v_hits;
  END IF;
  v_def := replace(v_def, c_other_from, c_other_to);

  -- 2 ── base_pinnacle: stop discarding 370 real locked readings for a literal.
  --      ⚠ The UNION ALL above demands the same column ORDER in both branches,
  --      so lock_known is inserted immediately after is_locked in each.
  v_hits := (length(v_def) - length(replace(v_def, c_pin_from, ''))) / length(c_pin_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'base_pinnacle is_locked: expected exactly 1 occurrence, found % — the body has changed, re-derive', v_hits;
  END IF;
  v_def := replace(v_def, c_pin_from, c_pin_to);

  -- 3 ── enriched: project the new column so it reaches row_to_json().
  v_hits := (length(v_def) - length(replace(v_def, c_enriched_from, ''))) / length(c_enriched_from);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'enriched is_locked: expected exactly 1 occurrence, found % — the body has changed, re-derive', v_hits;
  END IF;
  v_def := replace(v_def, c_enriched_from, c_enriched_to);

  IF length(v_def) <= v_len THEN
    RAISE EXCEPTION 'transform did not grow the definition (% -> %) — refusing to apply', v_len, length(v_def);
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'get_wallet_moments_with_fmv: % -> % chars, lock_known added', v_len, length(v_def);
END
$mig$;

-- Post-condition, asserted rather than assumed: the live body must now carry
-- lock_known, must no longer COALESCE the lock to false, and must no longer
-- hardcode Pinnacle's lock.
DO $check$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wallet_moments_with_fmv';

  IF position('lock_known' in v_def) = 0 THEN
    RAISE EXCEPTION 'post-check: lock_known absent from the live body';
  END IF;
  IF position('COALESCE(wmc.is_locked, false)' in v_def) > 0 THEN
    RAISE EXCEPTION 'post-check: the lock is still COALESCEd to false';
  END IF;
  IF position(E'\n      false AS is_locked,' in v_def) > 0 THEN
    RAISE EXCEPTION 'post-check: Pinnacle still hardcodes its lock';
  END IF;
END
$check$;

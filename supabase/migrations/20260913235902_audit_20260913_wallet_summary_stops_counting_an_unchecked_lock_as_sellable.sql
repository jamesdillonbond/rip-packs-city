-- audit_20260913_wallet_summary_stops_counting_an_unchecked_lock_as_sellable
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- The second instance of register #112, found while auditing what blocked the
-- All Day un-suppression. `get_wallet_summary` feeds the COLLECTION TAB's
-- headline "Unlocked FMV" tile (lib/portfolio-summary-compute.ts →
-- components/wallet-stat-row.tsx) and computed it as:
--
--     SUM(CASE WHEN NOT is_locked THEN fmv_usd ELSE 0 END)
--     COUNT(*) ... WHERE NOT is_locked
--
-- `NOT is_locked` is TRUE for the column DEFAULT, and 1,160,468 of 1,767,936
-- Top Shot rows in wallet_moments_cache have `lock_checked_at` NULL with
-- `is_locked = true` on exactly zero of them. So every unchecked moment was
-- counted as sellable. Measured on a real 17-moment wallet: unlocked_fmv read
-- $4.55 where only $1.16 was actually verified unlocked — a ~3x overstatement
-- of what the collector could sell.
--
-- ⚠ This is the SAME defect as 20260913231145 (get_wallet_moments_with_fmv) on
-- a DIFFERENT function feeding a DIFFERENT surface. Fixing the first did not
-- fix this one, and naming three surfaces in #112's filing missed this fourth.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- `lock_known` joins moment_data; unlocked_fmv / unlocked_count now require it;
-- and the unchecked remainder is reported as lock_unknown_fmv /
-- lock_unknown_count rather than folded into either side. Additive: a consumer
-- that ignores the new keys sees the same shape, with an unlocked figure that
-- now excludes what nobody checked.
--
-- ⭐ POSITIVE CONTROL, run before and after. All Day is 99.6% lock-checked, so
-- it must land ~0 in the unknown bucket while Top Shot lands most of a wallet
-- there. Measured after apply: Top Shot 3 locked / 4 unlocked / 10 unknown;
-- All Day 1 locked / 70 unlocked / 0 unknown. A change that merely swept
-- everything into "unknown" would look identical on Top Shot and would have
-- broken All Day — which is the whole reason the control is a second collection
-- and not a second wallet.
--
-- Applied as a guarded transform of the live definition; each replacement RAISEs
-- unless it matches exactly once, and a post-condition block asserts the new
-- body has the bucket and no longer carries either ungated predicate.
--
-- anon-exec: intentional — get_wallet_summary backs the un-gated collection tab
-- and the public wallet surfaces, so anon keeps EXECUTE. ⚠ This file is a RECORD
-- of a transform that was applied via MCP, not a fresh CREATE; re-running it is
-- a no-op because every guarded replacement will find 0 occurrences and RAISE.
-- That is intentional: it must not silently re-apply against a body someone
-- else has since changed.
--
-- REVERT: restore `SUM(CASE WHEN NOT is_locked THEN fmv_usd ELSE 0 END)` and
-- `'unlocked_count', (SELECT COUNT(*) FROM moment_data WHERE NOT is_locked)`,
-- and drop the lock_known column plus the two lock_unknown_* keys. No data is
-- written by this migration.

DO $mig$
DECLARE
  v_def text; v_len int; v_hits int;
  c_sel_from    CONSTANT text := E'      wmc.is_locked,';
  c_sel_to      CONSTANT text := E'      wmc.is_locked,\n      (wmc.lock_checked_at IS NOT NULL) AS lock_known,';
  c_fmv_from    CONSTANT text := 'SUM(CASE WHEN NOT is_locked THEN fmv_usd ELSE 0 END)';
  c_fmv_to      CONSTANT text := 'SUM(CASE WHEN lock_known AND NOT is_locked THEN fmv_usd ELSE 0 END)';
  c_cnt_from    CONSTANT text := '''unlocked_count'', (SELECT COUNT(*) FROM moment_data WHERE NOT is_locked)';
  c_cnt_to      CONSTANT text := '''unlocked_count'', (SELECT COUNT(*) FROM moment_data WHERE lock_known AND NOT is_locked),'
                                 || E'\n    ''lock_unknown_fmv'', (SELECT ROUND(COALESCE(SUM(CASE WHEN NOT lock_known THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),'
                                 || E'\n    ''lock_unknown_count'', (SELECT COUNT(*) FROM moment_data WHERE NOT lock_known)';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_wallet_summary';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_wallet_summary() not found'; END IF;
  v_len := length(v_def);

  v_hits := (length(v_def)-length(replace(v_def,c_sel_from,'')))/length(c_sel_from);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'moment_data is_locked: expected 1, found %', v_hits; END IF;
  v_def := replace(v_def, c_sel_from, c_sel_to);

  v_hits := (length(v_def)-length(replace(v_def,c_fmv_from,'')))/length(c_fmv_from);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'unlocked_fmv: expected 1, found %', v_hits; END IF;
  v_def := replace(v_def, c_fmv_from, c_fmv_to);

  v_hits := (length(v_def)-length(replace(v_def,c_cnt_from,'')))/length(c_cnt_from);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'unlocked_count: expected 1, found %', v_hits; END IF;
  v_def := replace(v_def, c_cnt_from, c_cnt_to);

  IF length(v_def) <= v_len THEN RAISE EXCEPTION 'transform did not grow the body'; END IF;
  EXECUTE v_def;
  RAISE NOTICE 'get_wallet_summary: % -> % chars', v_len, length(v_def);
END $mig$;

DO $check$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_wallet_summary';
  IF position('lock_unknown_count' in v_def)=0 THEN RAISE EXCEPTION 'post-check: unknown bucket absent'; END IF;
  IF position('WHEN NOT is_locked THEN fmv_usd' in v_def)>0 THEN RAISE EXCEPTION 'post-check: unlocked_fmv still ungated'; END IF;
  IF position('WHERE NOT is_locked)' in v_def)>0 THEN RAISE EXCEPTION 'post-check: unlocked_count still ungated'; END IF;
END $check$;

-- 2026-11-14 (~12:50 PM PT, Cowork cloud) — Trevor: "the math doesn't seem to make sense" on the
-- Collection tab tiles. Wallet FMV headlines total − stale ($47,656.98 = $52,801.48 − $5,144.50 on
-- 0xbd94cade097e50ac) while Locked ($50,427.08) + Unlocked ($2,374.40) still CONTAINED the stale share,
-- so the two tiles summed to $52,801.48 — $5,144.50 more than the headline above them.
--
-- Splice: get_wallet_summary also returns the stale share split by lock state —
--   stale_locked_fmv   (is_locked, the same predicate as locked_fmv)
--   stale_unlocked_fmv (lock_known AND NOT is_locked, the same predicate as unlocked_fmv)
-- so the client can net each tile and Locked + Unlocked (+ lock-unknown) = Wallet FMV. Additive keys
-- only; every existing key is byte-identical.
--
-- Catalog splice, md5-asserted against the base 20261114201139 left (9b152cae25f05537cd7e8f354c3c9bc0),
-- rewritten through pg_get_functiondef so header, search_path, volatility carry verbatim.
-- CREATE OR REPLACE keeps the ACL.
-- anon-exec: unchanged (get_wallet_summary) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- Read back after apply (20261114205033, ~12:52 PM PT): md5(prosrc) 3da406da27a569551a98ee6afc2aaa2e,
-- anon EXECUTE still true. 0xbd94cade097e50ac (Top Shot): stale_locked_fmv 5144.50, stale_unlocked_fmv 0;
-- locked 50427.08 - 5144.50 + unlocked 2374.40 = 47656.98 = wallet_fmv 52801.48 - stale_fmv 5144.50. Every
-- pre-existing key unchanged (no-change control).
--
-- Revert: the inverse splice — remove the two inserted lines (v_add below) from pg_get_functiondef and
-- EXECUTE; the client treats an absent key as 0 (the pre-splice tiles).
DO $$
DECLARE
  v_oid    oid  := 'public.get_wallet_summary(text,uuid)'::regprocedure;
  v_anchor text := E'    ''stale_count'', (SELECT COUNT(*) FROM moment_data WHERE confidence = ''STALE''),\n';
  v_add    text := E'    ''stale_locked_fmv'', (SELECT ROUND(COALESCE(SUM(CASE WHEN confidence = ''STALE'' AND is_locked THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),\n'
               || E'    ''stale_unlocked_fmv'', (SELECT ROUND(COALESCE(SUM(CASE WHEN confidence = ''STALE'' AND lock_known AND NOT is_locked THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),\n';
  v_src    text;
  v_def    text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> '9b152cae25f05537cd7e8f354c3c9bc0' THEN
    RAISE EXCEPTION 'get_wallet_summary base drifted: md5 %', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'stale_count anchor not found exactly once';
  END IF;
  v_def := replace(pg_get_functiondef(v_oid), v_anchor, v_anchor || v_add);
  EXECUTE v_def;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('stale_unlocked_fmv' IN v_src) = 0 THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
END $$;

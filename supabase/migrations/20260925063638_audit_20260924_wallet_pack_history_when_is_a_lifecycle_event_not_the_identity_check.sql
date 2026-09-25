-- 2026-09-24 (PT) — /dashboard/packs said "RIPPED 1h ago" for a pack ripped in
-- February 2024 (and "HELD 1h ago" for reward packs held for months): the
-- index_holds leg of get_wallet_pack_history fed coalesce(acquired_at,
-- checked_at) into the events union, so the Dapper identity CHECK time became
-- the pack's latest_event_at — the WHEN column and the sort key. Every pack the
-- hourly identity sync touches floats to the top stamped with the sync time;
-- a reader cannot tell "ripped an hour ago" from "confirmed an hour ago" (the
-- 'DONE stamp that cannot tell IN FLIGHT from FINISHED' class, on a date).
--
-- Change (guarded splice on the LIVE body, prosrc md5
-- 43bfc81fe9b073fb143bf57c9272c910): index_holds contributes acquired_at
-- ONLY. A pack whose only dated fact is the check keeps latest_event_at NULL,
-- sorts last (NULLS LAST, unchanged) and renders "—" in WHEN; the identity
-- check time still travels as identity_checked_at. Everything else byte-identical.
-- anon-exec: intentional — SPLICE of get_wallet_pack_history, an existing service_role-only function; its ACL is untouched.
-- Revert: re-apply 20260920171011_audit_20260920_wallet_pack_history_trusts_ownership_only_at_or_after_the_last_clean_walk.sql (then the 20260925051809 sentinel gate on top).
DO $$
DECLARE
  v_def text;
  v_a   text := 'coalesce(acquired_at, checked_at) AS at,';
  v_n   text := 'acquired_at AS at,  -- 2026-09-24: never the CHECK time (see header)';
  v_c   int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_wallet_pack_history';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_wallet_pack_history not found'; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
  IF v_c <> 1 THEN RAISE EXCEPTION 'index_holds anchor found % times', v_c; END IF;
  EXECUTE replace(v_def, v_a, v_n);
END $$;

DO $$
DECLARE v jsonb; v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'get_wallet_pack_history';
  IF position('coalesce(acquired_at, checked_at)' IN v_src) > 0 THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
  v := public.get_wallet_pack_history('0xbd94cade097e50ac', NULL, NULL, 1, 0);
  -- The first row is the most recent REAL event, which cannot be the identity check.
  IF (v->'packs'->0->>'latest_event_at') IS NOT NULL
     AND (v->'packs'->0->>'latest_event_at')::timestamptz = (v->'packs'->0->>'identity_checked_at')::timestamptz THEN
    RAISE EXCEPTION 'first row still dated by the identity check: %', v->'packs'->0;
  END IF;
END $$;

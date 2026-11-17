-- DB invariant: public.admin_verify_wallet(uuid, text, text) → jsonb — the
-- owner-attested wallet-verification fallback. Validates args strictly, upserts a
-- saved_wallets row to verified (owner_attested) with a case-insensitive match so
-- it never mints a duplicate, and grants the link_wallet earn via award_points.
-- A regression that skipped validation, duplicated the wallet row, or mis-set the
-- pre_existing_row flag would corrupt the saved-wallet + rewards accounting.
--
-- award_points is STUBBED here (it is pinned by its own test) so this test
-- isolates admin_verify_wallet's own logic and asserts only that it delegates.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802183500_audit_20260802_snapshot_admin_verify_wallet.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE saved_wallets (
  wallet_addr         text,
  user_id             uuid,
  verified_at         timestamptz,
  verification_method text
);

-- Stub award_points (pinned separately) — records the earn key it was handed.
CREATE OR REPLACE FUNCTION public.award_points(p_user_id uuid, p_earn text, p_ref text)
  RETURNS jsonb LANGUAGE sql AS $a$ SELECT jsonb_build_object('stub', true, 'earn', p_earn, 'ref', p_ref) $a$;

-- >>> BEGIN verbatim admin_verify_wallet (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.admin_verify_wallet(p_user_id uuid, p_wallet_addr text, p_admin text DEFAULT 'owner'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_wallet text := lower(trim(p_wallet_addr)); v_updated int := 0; v_award jsonb;
BEGIN
  IF p_user_id IS NULL OR v_wallet !~ '^0x[0-9a-f]{16}$' THEN
    RETURN jsonb_build_object('ok',false,'error','bad_args'); END IF;

  UPDATE saved_wallets
     SET verified_at = now(), verification_method = 'owner_attested'
   WHERE user_id = p_user_id AND lower(wallet_addr) = v_wallet;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    INSERT INTO saved_wallets(wallet_addr, user_id, verified_at, verification_method)
    VALUES (v_wallet, p_user_id, now(), 'owner_attested');
  END IF;

  -- The attested user gets the link_wallet earn exactly as if they verified
  -- (per_user_limit=1 makes repeats no-ops).
  v_award := award_points(p_user_id, 'link_wallet', v_wallet);

  RETURN jsonb_build_object('ok',true,'wallet',v_wallet,'pre_existing_row',v_updated>0,
                            'attested_by',p_admin,'link_wallet_award',v_award);
END $function$;
-- <<< END verbatim admin_verify_wallet <<<

-- Bad args → bad_args, and NOTHING is written.
SELECT _assert_eq(admin_verify_wallet(NULL, '0xbd94cade097e50ac')->>'error', 'bad_args', 'NULL user → bad_args');
SELECT _assert_eq(admin_verify_wallet('11111111-1111-1111-1111-111111111111', '0xNOTHEX')->>'error', 'bad_args', 'malformed wallet → bad_args');
SELECT _assert_eq(admin_verify_wallet('11111111-1111-1111-1111-111111111111', '0xdeadbeef')->>'error', 'bad_args', 'too-short wallet → bad_args');
SELECT _assert_eq((SELECT count(*)::text FROM saved_wallets), '0', 'bad-args calls wrote nothing');

-- New wallet (no existing saved_wallets row) → INSERT, pre_existing_row false,
-- verified as owner_attested, and the link_wallet earn is delegated.
SELECT _assert_eq(
  admin_verify_wallet('11111111-1111-1111-1111-111111111111', '0xbd94cade097e50ac')->>'pre_existing_row',
  'false', 'unsaved wallet → pre_existing_row false');
SELECT _assert_eq((SELECT verification_method FROM saved_wallets WHERE wallet_addr='0xbd94cade097e50ac'), 'owner_attested', 'inserted row marked owner_attested');
SELECT _assert(( (SELECT verified_at FROM saved_wallets WHERE wallet_addr='0xbd94cade097e50ac') IS NOT NULL ), 'inserted row has verified_at');
SELECT _assert_eq(
  admin_verify_wallet('11111111-1111-1111-1111-111111111111', '0xbd94cade097e50ac')->'link_wallet_award'->>'earn',
  'link_wallet', 'delegates the link_wallet earn to award_points');

-- Existing row, CASE-INSENSITIVE match → UPDATE in place (pre_existing_row true),
-- never a duplicate. The stored addr is uppercase; the call passes uppercase too
-- (lowercased internally) and must still match the same row.
INSERT INTO saved_wallets (wallet_addr, user_id, verified_at, verification_method) VALUES
  ('0xA3D67B29E104E701', '22222222-2222-2222-2222-222222222222', NULL, NULL);
SELECT _assert_eq(
  admin_verify_wallet('22222222-2222-2222-2222-222222222222', '0xA3D67B29E104E701')->>'pre_existing_row',
  'true', 'already-saved wallet → pre_existing_row true');
SELECT _assert_eq((SELECT count(*)::text FROM saved_wallets WHERE user_id='22222222-2222-2222-2222-222222222222'), '1', 'case-insensitive match did NOT mint a duplicate row');
SELECT _assert_eq((SELECT verification_method FROM saved_wallets WHERE user_id='22222222-2222-2222-2222-222222222222'), 'owner_attested', 'existing row upgraded to owner_attested');

SELECT '✓ admin_verify_wallet invariants pass' AS result;
ROLLBACK;

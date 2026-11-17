-- DB invariant: public.grant_pro_grandfather(text,text) — a Pro-ENTITLEMENT mint
-- granting the non-expiring 'pro_grandfather' plan. Load-bearing money-safety
-- invariants pinned here:
--   * the empty-wallet guard (no write, success:false wallet_required);
--   * NEVER downgrade a higher tier -- an existing non-expiring founding/admin plan
--     is left UNTOUCHED (no_op_higher_tier);
--   * idempotence when already grandfathered (no_op, no write);
--   * INSERT path: a wallet with no row gets a non-expiring pro_grandfather grant,
--     granted_by 'system', grant_reason = p_reason, action 'granted';
--   * UPGRADE path: an EXPIRED/lower plan (e.g. moments_payment) is rewritten to a
--     non-expiring pro_grandfather in place, action 'upgraded_from_<plan>';
--   * the denormalized seeded_wallets.is_pro_user cache is set true;
--   * the wallet is lower/trimmed before matching (an UPPER/padded input hits the
--     same row).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231900_audit_20260801_snapshot_grant_pro_grandfather.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (3a51be24f6237f47aad1de363371a832).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pro_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  subscribed_at timestamptz NOT NULL,
  expires_at timestamptz,
  plan text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  granted_by text,
  grant_reason text,
  auto_renew boolean NOT NULL DEFAULT false
);
CREATE TABLE seeded_wallets (
  wallet_address text, is_pro_user boolean, pro_conversion_at timestamptz
);

-- >>> BEGIN verbatim grant_pro_grandfather (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.grant_pro_grandfather(p_wallet text, p_reason text DEFAULT 'Phase 1 closed beta invitee'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_existing_plan text;
  v_existing_expires timestamptz;
BEGIN
  IF v_wallet IS NULL OR v_wallet = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wallet_required');
  END IF;

  -- Check existing state separately to avoid the ON CONFLICT path always firing
  SELECT plan, expires_at INTO v_existing_plan, v_existing_expires 
  FROM pro_users 
  WHERE wallet_address = v_wallet;

  -- Don't downgrade founding/admin plans (they're either equal or higher than grandfather)
  IF v_existing_plan IN ('founding', 'admin') AND v_existing_expires IS NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'action', 'no_op_higher_tier',
      'wallet', v_wallet, 'existing_plan', v_existing_plan
    );
  END IF;

  -- Already grandfathered: no-op
  IF v_existing_plan = 'pro_grandfather' AND v_existing_expires IS NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'action', 'no_op_already_grandfathered',
      'wallet', v_wallet
    );
  END IF;

  -- Either no existing row or existing row is upgradeable (e.g., expired moments_payment)
  IF v_existing_plan IS NULL THEN
    INSERT INTO pro_users (wallet_address, subscribed_at, expires_at, plan, granted_by, grant_reason)
    VALUES (v_wallet, now(), NULL, 'pro_grandfather', 'system', p_reason);
  ELSE
    UPDATE pro_users 
    SET plan = 'pro_grandfather',
        expires_at = NULL,
        granted_by = 'system',
        grant_reason = p_reason
    WHERE wallet_address = v_wallet;
  END IF;

  -- Update the denormalized seeded_wallets cache
  UPDATE seeded_wallets 
  SET is_pro_user = true, 
      pro_conversion_at = COALESCE(pro_conversion_at, now()) 
  WHERE lower(wallet_address) = v_wallet;

  RETURN jsonb_build_object(
    'success', true, 'action', 
    CASE WHEN v_existing_plan IS NULL THEN 'granted' ELSE 'upgraded_from_' || v_existing_plan END,
    'wallet', v_wallet, 'plan', 'pro_grandfather'
  );
END;
$function$;
-- <<< END verbatim grant_pro_grandfather <<<

INSERT INTO pro_users (wallet_address, subscribed_at, expires_at, plan) VALUES
  ('0xfounder', now(), NULL, 'founding'),                       -- higher tier -> untouched
  ('0xgrand',   now(), NULL, 'pro_grandfather'),                -- already grandfathered -> no-op
  ('0xexpired', now(), now() - interval '1 day', 'moments_payment'); -- expired -> upgradeable
INSERT INTO seeded_wallets (wallet_address, is_pro_user, pro_conversion_at) VALUES
  ('0xnewbie',  false, NULL),
  ('0xexpired', false, NULL);

-- 1) Empty wallet -> guard, no write.
SELECT _assert_eq((grant_pro_grandfather('   ', 'r')->>'success'), 'false', 'blank wallet -> success:false');
SELECT _assert_eq((grant_pro_grandfather('', 'r')->>'reason'), 'wallet_required', 'blank wallet reason');

-- 2) NEVER downgrade a founding plan: no_op_higher_tier, row unchanged.
SELECT _assert_eq((grant_pro_grandfather('0xfounder','r')->>'action'), 'no_op_higher_tier', 'founding plan not downgraded');
SELECT _assert_eq((SELECT plan FROM pro_users WHERE wallet_address='0xfounder'), 'founding', 'founding plan row is untouched');

-- 3) Already grandfathered -> no-op.
SELECT _assert_eq((grant_pro_grandfather('0xgrand','r')->>'action'), 'no_op_already_grandfathered', 'already grandfathered -> no-op');

-- 4) INSERT path: unknown wallet -> new non-expiring grant + denorm flip; UPPER input matches the lowercased seeded_wallets row.
SELECT _assert_eq((grant_pro_grandfather('0xNEWBIE','my-reason')->>'action'), 'granted', 'new wallet -> granted');
SELECT _assert_eq(
  (SELECT plan||'|'||coalesce(expires_at::text,'NULL')||'|'||granted_by||'|'||grant_reason FROM pro_users WHERE wallet_address='0xnewbie'),
  'pro_grandfather|NULL|system|my-reason', 'INSERT row is a non-expiring system grant carrying the reason');
SELECT _assert_eq((SELECT is_pro_user::text FROM seeded_wallets WHERE wallet_address='0xnewbie'), 'true', 'seeded_wallets cache flipped to pro via the lowercased wallet');

-- 5) UPGRADE path: expired plan rewritten in place to a non-expiring grandfather.
SELECT _assert_eq((grant_pro_grandfather('0xexpired','r2')->>'action'), 'upgraded_from_moments_payment', 'expired plan -> upgraded_from_moments_payment');
SELECT _assert_eq(
  (SELECT plan||'|'||coalesce(expires_at::text,'NULL') FROM pro_users WHERE wallet_address='0xexpired'),
  'pro_grandfather|NULL', 'upgraded row is now non-expiring pro_grandfather');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users WHERE wallet_address='0xexpired'), '1', 'upgrade is in-place (no duplicate row)');

SELECT '✓ grant_pro_grandfather invariants pass' AS result;
ROLLBACK;

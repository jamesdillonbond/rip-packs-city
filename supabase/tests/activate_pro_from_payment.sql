-- DB invariant: public.activate_pro_from_payment(...) — the ON-CHAIN Pro-payment
-- MONEY MINT. A collector sends a moment to the merchant wallet and this
-- activates/extends Pro. Load-bearing guards:
--   * minimum-FMV floor — a below-floor moment must NOT buy Pro (and nothing is
--     logged/activated);
--   * DUPLICATE-MOMENT guard on moment_nft_id — one moment can buy Pro only ONCE
--     (the on-chain idempotency: a re-submitted tx must not re-activate for free);
--   * a NULL FMV skips the floor (activation still allowed).
--
-- ⚠ SUBTLE, PINNED-ON-PURPOSE (identical to activate_pro_from_stripe): the
-- "extend" branch is gated on `v_existing_pro RECORD ... IF v_existing_pro IS NOT
-- NULL`. A composite IS NOT NULL is true only when EVERY column is non-null, but
-- pro_users carries nullable columns (granted_by, grant_reason) this writer never
-- populates — so a NORMALLY-created active sub takes the ELSE branch and is RESET
-- to now()+duration (extended=false), NOT extended off its current expiry. The
-- add-duration-on-top extend path only fires for a fully-populated row. Both are
-- pinned below against the REAL pro_users shape.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230200_audit_20260801_snapshot_activate_pro_from_payment.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (7912e1ddc9228370121b8b21f4fb265f).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- pro_users mirrors the REAL prod shape (9 cols; nullable granted_by/grant_reason).
CREATE TABLE pro_users (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  wallet_address text PRIMARY KEY,
  subscribed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  plan           text NOT NULL DEFAULT 'pro',
  created_at     timestamptz NOT NULL DEFAULT now(),
  granted_by     text,
  grant_reason   text,
  auto_renew     boolean NOT NULL DEFAULT false
);
CREATE TABLE pro_payment_log (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  sender_wallet     text,
  moment_nft_id     text,
  moment_flow_id    text,
  player_name       text,
  set_name          text,
  tier              text,
  fmv_at_payment    numeric,
  transaction_hash  text,
  collection_id     uuid,
  pro_duration_days int,
  pro_activated     boolean,
  created_at        timestamptz DEFAULT now()
);

-- >>> BEGIN verbatim activate_pro_from_payment (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.activate_pro_from_payment(p_sender_wallet text, p_moment_nft_id text, p_moment_flow_id text DEFAULT NULL::text, p_player_name text DEFAULT NULL::text, p_set_name text DEFAULT NULL::text, p_tier text DEFAULT NULL::text, p_fmv numeric DEFAULT NULL::numeric, p_tx_hash text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid, p_duration_days integer DEFAULT 30, p_min_fmv numeric DEFAULT 2.00)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_pro RECORD;
  v_new_expires timestamptz;
BEGIN
  -- Validate minimum FMV
  IF p_fmv IS NOT NULL AND p_fmv < p_min_fmv THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', format('Moment FMV ($%s) below minimum ($%s)', p_fmv, p_min_fmv)
    );
  END IF;

  -- Check for duplicate payment
  IF EXISTS (SELECT 1 FROM pro_payment_log WHERE moment_nft_id = p_moment_nft_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Moment already used for Pro payment');
  END IF;

  -- Log the payment
  INSERT INTO pro_payment_log (
    sender_wallet, moment_nft_id, moment_flow_id, player_name, set_name,
    tier, fmv_at_payment, transaction_hash, collection_id, pro_duration_days, pro_activated
  ) VALUES (
    p_sender_wallet, p_moment_nft_id, p_moment_flow_id, p_player_name, p_set_name,
    p_tier, p_fmv, p_tx_hash, p_collection_id, p_duration_days, true
  );

  -- Check existing Pro subscription
  SELECT * INTO v_existing_pro FROM pro_users WHERE wallet_address = p_sender_wallet;

  IF v_existing_pro IS NOT NULL AND v_existing_pro.expires_at > now() THEN
    -- Extend existing subscription
    v_new_expires := v_existing_pro.expires_at + (p_duration_days || ' days')::interval;
    UPDATE pro_users SET expires_at = v_new_expires WHERE wallet_address = p_sender_wallet;
  ELSE
    -- Create or reactivate
    v_new_expires := now() + (p_duration_days || ' days')::interval;
    INSERT INTO pro_users (wallet_address, subscribed_at, expires_at, plan)
    VALUES (p_sender_wallet, now(), v_new_expires, 'moments_payment')
    ON CONFLICT (wallet_address) DO UPDATE
    SET subscribed_at = now(), expires_at = v_new_expires, plan = 'moments_payment';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'wallet', p_sender_wallet,
    'expires_at', v_new_expires,
    'duration_days', p_duration_days,
    'moment_fmv', p_fmv,
    'extended', v_existing_pro IS NOT NULL AND v_existing_pro.expires_at > now()
  );
END;
$function$;
-- <<< END verbatim activate_pro_from_payment <<<

-- 1) BELOW-MIN FMV — a $1 moment (default floor $2) is rejected and NOTHING lands.
SELECT _assert(
  (activate_pro_from_payment('w_low','m_low', NULL,NULL,NULL,NULL, 1.00)->>'reason') LIKE 'Moment FMV%below minimum%',
  'below-min FMV rejected');
SELECT _assert_eq((SELECT count(*)::text FROM pro_payment_log), '0', 'below-min FMV logs no payment');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users), '0', 'below-min FMV activates no Pro');

-- 2) DUPLICATE MOMENT — a moment already in the log can't buy Pro again.
INSERT INTO pro_payment_log (moment_nft_id) VALUES ('m_dupe');
SELECT _assert_eq(
  (activate_pro_from_payment('w_dupe','m_dupe', NULL,NULL,NULL,NULL, 100.0)->>'reason'),
  'Moment already used for Pro payment', 'duplicate moment rejected');
SELECT _assert_eq((SELECT count(*)::text FROM pro_payment_log WHERE moment_nft_id='m_dupe'), '1',
  'duplicate moment does not double-log');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users WHERE wallet_address='w_dupe'), '0',
  'duplicate moment does not activate');

-- 3) FRESH ACTIVATE — priced moment, no prior sub → moments_payment, ~now+30d.
SELECT _assert_eq(
  (activate_pro_from_payment('w_new','m_new', NULL,NULL,NULL,NULL, 50.0, NULL, NULL, 30)->>'extended'),
  'false', 'fresh activate is not an extension');
SELECT _assert_eq(
  (SELECT plan||'|'|| ((expires_at > now()+interval '25 days') AND (expires_at < now()+interval '35 days'))::text
     FROM pro_users WHERE wallet_address='w_new'),
  'moments_payment|true', 'fresh activate writes moments_payment with ~now+duration expiry');
SELECT _assert_eq((SELECT pro_activated::text FROM pro_payment_log WHERE moment_nft_id='m_new'), 'true',
  'payment logged as activated');

-- 4) NULL FMV skips the floor — activation still allowed.
SELECT _assert_eq(
  (activate_pro_from_payment('w_nullfmv','m_nullfmv', NULL,NULL,NULL,NULL, NULL)->>'success'),
  'true', 'null FMV skips the minimum-FMV floor');

-- 5) NORMALLY-created active sub → RESET to now()+duration, extended=false. The
--    granted_by/grant_reason columns are NULL (writer never sets them), so the
--    composite `v_existing_pro IS NOT NULL` is false and the ELSE branch runs —
--    it does NOT add duration on top of the current expiry.
INSERT INTO pro_users (wallet_address, subscribed_at, expires_at, plan)
VALUES ('w_norm', now(), now() + interval '100 days', 'moments_payment');  -- granted_by/reason NULL
SELECT _assert_eq(
  (activate_pro_from_payment('w_norm','m_norm', NULL,NULL,NULL,NULL, 50.0, NULL, NULL, 30)->>'extended'),
  'false', 'normally-created active sub → extended=false (extend branch dead for null-column rows)');
SELECT _assert_eq(
  (SELECT (expires_at < now()+interval '35 days')::text FROM pro_users WHERE wallet_address='w_norm'),
  'true', 'normally-created active sub is RESET to now()+duration, not extended off its 100d expiry');

-- 6) A FULLY-POPULATED active sub (every column non-null) DOES extend — the
--    duration is ADDED on top of the current expiry (100d + 30d).
INSERT INTO pro_users (wallet_address, subscribed_at, expires_at, plan, created_at, granted_by, grant_reason, auto_renew)
VALUES ('w_full', now(), now() + interval '100 days', 'moments_payment', now(), 'admin', 'comp', true);
SELECT _assert_eq(
  (activate_pro_from_payment('w_full','m_full', NULL,NULL,NULL,NULL, 50.0, NULL, NULL, 30)->>'extended'),
  'true', 'fully-populated active sub → extended=true');
SELECT _assert(
  (SELECT expires_at FROM pro_users WHERE wallet_address='w_full') > now() + interval '125 days',
  'extend ADDS duration on top of the existing expiry (100d + 30d)');

SELECT '✓ activate_pro_from_payment invariants pass' AS result;
ROLLBACK;

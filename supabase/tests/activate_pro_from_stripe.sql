-- DB invariant: public.activate_pro_from_stripe(...) — the Pro-subscription MONEY
-- MINT reached from the Stripe webhook. Because it is a payment writer that a
-- webhook platform RETRIES, every guard is load-bearing:
--   * IDEMPOTENCY on stripe_event_id — a replayed event returns early and writes
--     NOTHING (no second payment-log row, no re-activation);
--   * wallet resolution: explicit → earliest saved_wallet, LOWER-cased to the
--     canonical pro_users key;
--   * no wallet linked → payment logged 'pending', Pro NOT activated;
--   * fresh activate writes a pro_users row (plan pro_paid, expires_at=period_end);
--   * an ACTIVE subscription is EXTENDED never SHORTENED (GREATEST), while an
--     EXPIRED one is reset to the new period.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230000_audit_20260801_snapshot_activate_pro_from_stripe.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it,
-- and the md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on
-- 2026-08-01 (ae5f563a46b4ba2b2bed462c74185367).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pro_users (
  wallet_address text PRIMARY KEY,
  subscribed_at  timestamptz,
  expires_at     timestamptz,
  plan           text,
  auto_renew     boolean
);
CREATE TABLE stripe_payment_log (
  id                    bigint GENERATED ALWAYS AS IDENTITY,
  user_id               uuid,
  wallet_address        text,
  stripe_customer_id    text,
  stripe_subscription_id text,
  stripe_event_id       text,
  amount_usd            numeric,
  plan_name             text,
  billing_period_start  timestamptz,
  billing_period_end    timestamptz,
  status                text,
  raw_webhook_payload   jsonb,
  created_at            timestamptz DEFAULT now()
);
CREATE TABLE saved_wallets (
  user_id    uuid,
  wallet_addr text,
  created_at timestamptz DEFAULT now()
);

-- >>> BEGIN verbatim activate_pro_from_stripe (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.activate_pro_from_stripe(p_user_id uuid, p_wallet_address text, p_stripe_customer_id text, p_stripe_subscription_id text, p_stripe_event_id text, p_amount_usd numeric, p_plan_name text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_raw_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing pro_users%ROWTYPE;
  v_resolved_wallet text;
BEGIN
  -- Idempotency: if we already processed this Stripe event, return early
  IF EXISTS (SELECT 1 FROM stripe_payment_log WHERE stripe_event_id = p_stripe_event_id) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'message', 'already processed');
  END IF;

  -- Resolve wallet: prefer explicit, fall back to user's primary saved_wallet.
  -- LOWER both sides — pro_users.wallet_address is the canonical lowercase
  -- key; Stripe metadata can carry mixed case if the checkout caller didn't
  -- normalise.
  v_resolved_wallet := LOWER(COALESCE(p_wallet_address, (
    SELECT wallet_addr FROM saved_wallets
    WHERE user_id = p_user_id
    ORDER BY created_at ASC
    LIMIT 1
  )));

  IF v_resolved_wallet IS NULL THEN
    -- No wallet linked yet — log payment as pending without activating.
    INSERT INTO stripe_payment_log (
      user_id, stripe_customer_id, stripe_subscription_id, stripe_event_id,
      amount_usd, plan_name, billing_period_start, billing_period_end, status, raw_webhook_payload
    ) VALUES (
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_stripe_event_id,
      p_amount_usd, p_plan_name, p_period_start, p_period_end, 'pending', p_raw_payload
    );
    RETURN jsonb_build_object('success', false, 'reason', 'no wallet linked yet — payment logged as pending');
  END IF;

  -- Log the payment
  INSERT INTO stripe_payment_log (
    user_id, wallet_address, stripe_customer_id, stripe_subscription_id, stripe_event_id,
    amount_usd, plan_name, billing_period_start, billing_period_end, status, raw_webhook_payload
  ) VALUES (
    p_user_id, v_resolved_wallet, p_stripe_customer_id, p_stripe_subscription_id, p_stripe_event_id,
    p_amount_usd, p_plan_name, p_period_start, p_period_end, 'succeeded', p_raw_payload
  );

  -- Activate or extend Pro on the wallet
  SELECT * INTO v_existing FROM pro_users WHERE wallet_address = v_resolved_wallet;

  IF v_existing IS NOT NULL AND v_existing.expires_at > NOW() THEN
    -- Extend
    UPDATE pro_users
    SET expires_at = GREATEST(v_existing.expires_at, p_period_end),
        plan = 'pro_paid',
        auto_renew = true
    WHERE wallet_address = v_resolved_wallet;
  ELSE
    INSERT INTO pro_users (wallet_address, subscribed_at, expires_at, plan, auto_renew)
    VALUES (v_resolved_wallet, NOW(), p_period_end, 'pro_paid', true)
    ON CONFLICT (wallet_address) DO UPDATE
    SET subscribed_at = NOW(), expires_at = p_period_end, plan = 'pro_paid', auto_renew = true;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'wallet', v_resolved_wallet,
    'expires_at', p_period_end,
    'plan', 'pro_paid'
  );
END;
$function$;
-- <<< END verbatim activate_pro_from_stripe <<<

-- U1 = ...0001, U2 = ...0002
-- Helper call signature (order): user, wallet, customer, subscription, event,
-- amount, plan, period_start, period_end, raw_payload.

-- 1) IDEMPOTENCY — a stripe_event_id we already logged returns early and writes
--    nothing (this is the webhook-retry safety property).
INSERT INTO stripe_payment_log (stripe_event_id, status) VALUES ('evt_dupe', 'succeeded');
SELECT _assert_eq(
  (activate_pro_from_stripe('00000000-0000-0000-0000-000000000001','0xdupe000000000001',
    'cus','sub','evt_dupe', 19.0,'Pro', now(), now() + interval '30 days', NULL)->>'idempotent'),
  'true', 'replayed event → idempotent=true');
SELECT _assert_eq((SELECT count(*)::text FROM stripe_payment_log WHERE stripe_event_id='evt_dupe'),
  '1', 'replayed event writes NO second payment-log row');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users WHERE wallet_address='0xdupe000000000001'),
  '0', 'replayed event does NOT activate Pro');

-- 2) NO WALLET — explicit null + no saved_wallet → logged pending, Pro NOT activated.
SELECT _assert(
  (activate_pro_from_stripe('00000000-0000-0000-0000-000000000002', NULL,
    'cus','sub','evt_nowallet', 19.0,'Pro', now(), now() + interval '30 days', NULL)->>'reason')
    LIKE 'no wallet linked%',
  'no wallet → reason reports pending');
SELECT _assert_eq((SELECT status FROM stripe_payment_log WHERE stripe_event_id='evt_nowallet'),
  'pending', 'no-wallet payment logged as pending');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users), '0', 'no-wallet path activates no Pro row');

-- 3) FRESH ACTIVATE + LOWER-casing — mixed-case hex resolves to the lowercase key.
SELECT _assert_eq(
  (activate_pro_from_stripe('00000000-0000-0000-0000-000000000003','0xABCDEF1234567890',
    'cus','sub','evt_new', 19.0,'Pro', now(), now() + interval '30 days', NULL)->>'wallet'),
  '0xabcdef1234567890', 'explicit wallet is LOWER-cased in the result');
SELECT _assert_eq(
  (SELECT plan||'|'|| (expires_at > now() + interval '25 days')::text
     FROM pro_users WHERE wallet_address='0xabcdef1234567890'),
  'pro_paid|true', 'fresh activate writes pro_paid row with period_end expiry');
SELECT _assert_eq((SELECT status FROM stripe_payment_log WHERE stripe_event_id='evt_new'),
  'succeeded', 'activated payment logged succeeded');

-- 4) WALLET FALLBACK — null explicit wallet resolves to the EARLIEST saved_wallet
--    (and is LOWER-cased). Two saved wallets; the older one wins.
INSERT INTO saved_wallets (user_id, wallet_addr, created_at) VALUES
  ('00000000-0000-0000-0000-000000000004','0xFEED000000000001', now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000004','0xFEED000000000002', now() - interval '1 days');
SELECT _assert_eq(
  (activate_pro_from_stripe('00000000-0000-0000-0000-000000000004', NULL,
    'cus','sub','evt_fallback', 19.0,'Pro', now(), now() + interval '30 days', NULL)->>'wallet'),
  '0xfeed000000000001', 'null wallet falls back to earliest saved_wallet, lowercased');

-- 5) EXTEND NEVER SHORTENS — an active sub with a FAR expiry, a nearer period_end
--    keeps the far date (GREATEST); a later period_end extends.
INSERT INTO pro_users VALUES ('0xext0000000000001', now(), now() + interval '365 days', 'pro_free', false);
SELECT activate_pro_from_stripe('00000000-0000-0000-0000-000000000005','0xext0000000000001',
  'cus','sub','evt_ext_near', 19.0,'Pro', now(), now() + interval '30 days', NULL);
SELECT _assert_eq(
  (SELECT (expires_at > now() + interval '360 days')::text ||'|'|| plan ||'|'|| auto_renew::text
     FROM pro_users WHERE wallet_address='0xext0000000000001'),
  'true|pro_paid|true', 'nearer period_end does NOT shorten an active sub (GREATEST kept the far date)');

INSERT INTO pro_users VALUES ('0xext0000000000002', now(), now() + interval '10 days', 'pro_paid', true);
SELECT activate_pro_from_stripe('00000000-0000-0000-0000-000000000006','0xext0000000000002',
  'cus','sub','evt_ext_far', 19.0,'Pro', now(), now() + interval '400 days', NULL);
SELECT _assert(
  (SELECT expires_at FROM pro_users WHERE wallet_address='0xext0000000000002') > now() + interval '390 days',
  'a later period_end DOES extend an active sub');

-- 6) EXPIRED existing → reset to the new period (ELSE branch, not GREATEST-vs-past).
INSERT INTO pro_users VALUES ('0xexp0000000000001', now() - interval '400 days', now() - interval '10 days', 'pro_paid', true);
SELECT activate_pro_from_stripe('00000000-0000-0000-0000-000000000007','0xexp0000000000001',
  'cus','sub','evt_reactivate', 19.0,'Pro', now(), now() + interval '30 days', NULL);
SELECT _assert_eq(
  (SELECT ((expires_at > now() + interval '25 days') AND (expires_at < now() + interval '35 days'))::text
     FROM pro_users WHERE wallet_address='0xexp0000000000001'),
  'true', 'an EXPIRED sub is reset to the new period, not left in the past');

SELECT '✓ activate_pro_from_stripe invariants pass' AS result;
ROLLBACK;

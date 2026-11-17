-- Snapshot migration: public.activate_pro_from_stripe(uuid,text,text,text,text,numeric,text,timestamptz,timestamptz,jsonb).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: it is the Pro-subscription MONEY MINT — the Stripe webhook path
-- calls it to activate/extend a paid Pro subscription. Its load-bearing guards:
--   * IDEMPOTENCY on stripe_event_id — a replayed webhook returns early and
--     writes NOTHING (a payment log is retried; without this it would double-log
--     and re-activate);
--   * wallet resolution (explicit → earliest saved_wallet) and LOWER-casing to
--     the canonical pro_users key;
--   * no-wallet path logs the payment as 'pending' and does NOT activate Pro;
--   * activate/extend NEVER shortens an existing active subscription (GREATEST).

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

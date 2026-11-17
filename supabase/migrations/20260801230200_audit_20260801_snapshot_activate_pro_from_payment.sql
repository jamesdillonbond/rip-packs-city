-- Snapshot migration: public.activate_pro_from_payment(text,text,text,text,text,text,numeric,text,uuid,integer,numeric).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: the ON-CHAIN Pro-payment MONEY MINT — a collector sends a moment
-- to the merchant wallet and this activates/extends Pro. Load-bearing guards:
--   * minimum-FMV floor (a below-floor moment must NOT buy Pro);
--   * DUPLICATE-MOMENT guard on moment_nft_id — one moment can only ever buy Pro
--     once (the on-chain equivalent of idempotency; without it a re-submitted tx
--     re-activates for free);
--   * an ACTIVE subscription is EXTENDED by adding the duration on top of the
--     current expiry; an EXPIRED/absent one is (re)created from now().

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

-- Snapshot migration: public.grant_pro_grandfather(text,text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01; byte-identical, md5
-- 3a51be24f6237f47aad1de363371a832) so it can carry a pinned invariant test.
-- Applying it is a no-op against prod.
--
-- What it does: a Pro-ENTITLEMENT mint -- grants a wallet the 'pro_grandfather'
-- plan (non-expiring, granted_by 'system'). Load-bearing money-safety invariants:
-- it NEVER downgrades a higher founding/admin plan (returns no_op_higher_tier,
-- writes nothing), is idempotent when already grandfathered (no_op), INSERTs a new
-- non-expiring grant when the wallet has no row, UPGRADES an expired/lower plan in
-- place, and keeps the denormalized seeded_wallets.is_pro_user cache in sync. The
-- wallet is lower/trimmed; empty -> success:false wallet_required (no write).

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

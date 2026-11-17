-- audit_20260914: verify a wallet by an ON-CHAIN SIGNATURE, not by listing a Moment
--
-- WHY. Measured 2026-09-14: 135 saved_wallets, 9 verified (6.7%), newest
-- challenge of any kind 2026-06-15 — three months with nobody completing the
-- listing challenge. That flow asks a user to leave RPC, list a real asset at
-- an odd price on nbatopshot.com, and come back. The signature path asks for
-- one wallet popup and is verified by FCLCrypto (0xb4b82a1c9d21d284) on Flow
-- mainnet. See lib/auth/flow-signature.ts.
--
-- WHAT THIS ADDS. One SECURITY DEFINER function, additive. It deliberately
-- does NOT touch resolve_wallet_challenge_match: that function is pinned, is
-- called from three routes, and hardcodes verification_method =
-- 'listing_challenge'. Replacing it to take a method argument would be a
-- full-body write of a pinned object for no gain. The award and referral rules
-- below are copied from it VERBATIM so the two paths cannot pay differently.
--
-- No challenge row is written. The signature nonce is a recomputable HMAC
-- (lib/auth/flow-signature.ts), so there is no server-side state to reconcile
-- and nothing to expire — which is also why this takes a user + wallet rather
-- than a challenge id.
--
-- REVERT: DROP FUNCTION public.resolve_wallet_signature_match(uuid, text, uuid);
--         Nothing else references it; the listing challenge is unaffected.

CREATE OR REPLACE FUNCTION public.resolve_wallet_signature_match(
  p_user_id uuid,
  p_wallet text,
  p_referrer uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_saved record;
  v_award jsonb;
  v_ref_award jsonb;
  v_first boolean;
BEGIN
  IF p_user_id IS NULL OR p_wallet IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_argument');
  END IF;

  -- The wallet must already belong to this account. The caller has proved
  -- control of the ADDRESS; the saved row is what says this user asked us to
  -- associate it. Locked so two concurrent verifications cannot both award.
  SELECT * INTO v_saved
    FROM saved_wallets
   WHERE user_id = p_user_id
     AND lower(wallet_addr) = lower(p_wallet)
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wallet_not_saved');
  END IF;

  IF v_saved.verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_verified',
                              'verified_at', v_saved.verified_at);
  END IF;

  -- First-ever verified wallet for this user? Checked BEFORE the update, or
  -- the row we are about to write would make the answer always false.
  v_first := NOT EXISTS (
    SELECT 1 FROM saved_wallets
     WHERE user_id = p_user_id AND verified_at IS NOT NULL
  );

  UPDATE saved_wallets
     SET verified_at = now(),
         verification_method = 'wallet_signature'
   WHERE id = v_saved.id
     AND verified_at IS NULL;

  v_award := award_points(p_user_id, 'link_wallet', p_wallet);

  -- Referral: only on a genuinely-first verification, never self, and the
  -- referrer must be a real profile. Identical to the listing path.
  IF p_referrer IS NOT NULL AND v_first AND p_referrer <> p_user_id
     AND EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_referrer) THEN
    v_ref_award := award_points(p_referrer, 'referral_verified', p_user_id::text);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'wallet', lower(p_wallet),
    'method', 'wallet_signature',
    'first_verification', v_first,
    'link_wallet_award', v_award,
    'referral_award', v_ref_award
  );
END
$function$;

-- The route calls this with the service role only. Anon/authenticated must not
-- reach a SECDEF function that stamps verified_at: the signature check happens
-- in the route, so a direct PostgREST call would be verification-free.
-- One statement, both halves — either alone leaves a grant behind.
REVOKE ALL ON FUNCTION public.resolve_wallet_signature_match(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;

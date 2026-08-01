-- Snapshot migration: public.resolve_wallet_challenge_match(uuid,text,text,uuid).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: resolves a listing-challenge wallet verification and awards the
-- reward points. It is the credit-granting side of the on-demand wallet-verify
-- flow, so its guard ordering and referral gates are abuse-relevant: it locks the
-- challenge FOR UPDATE, rejects not-found / already-resolved / expired, marks the
-- saved_wallet verified, awards `link_wallet`, and grants a `referral_verified`
-- bonus ONLY on a genuinely-first verification, never for a self-referral, and
-- only when the referrer is a real profile.

CREATE OR REPLACE FUNCTION public.resolve_wallet_challenge_match(p_challenge_id uuid, p_matched_moment_id text, p_source text DEFAULT 'gql_on_demand'::text, p_referrer uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record; v_award jsonb; v_ref_award jsonb; v_first boolean;
BEGIN
  SELECT * INTO c FROM wallet_verification_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','challenge_not_found'); END IF;
  IF c.resolved_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','already_resolved','via',c.resolved_via); END IF;
  IF c.expires_at < now() THEN
    UPDATE wallet_verification_challenges SET resolved_at = now(), resolved_via = 'expired' WHERE id = p_challenge_id;
    RETURN jsonb_build_object('ok',false,'error','expired');
  END IF;

  -- Is this the user's first-ever verified wallet? (checked BEFORE verifying)
  v_first := NOT EXISTS (SELECT 1 FROM saved_wallets WHERE user_id = c.user_id AND verified_at IS NOT NULL);

  UPDATE wallet_verification_challenges
     SET resolved_at = now(), resolved_via = coalesce(p_source,'gql_on_demand'),
         matched_moment_id = p_matched_moment_id
   WHERE id = p_challenge_id;

  UPDATE saved_wallets
     SET verified_at = now(), verification_method = 'listing_challenge'
   WHERE user_id = c.user_id AND lower(wallet_addr) = lower(c.wallet_addr)
     AND verified_at IS NULL;

  v_award := award_points(c.user_id, 'link_wallet', c.wallet_addr);

  -- Referral: only on a genuinely-first verification, never self, referrer must be real.
  IF p_referrer IS NOT NULL AND v_first AND p_referrer <> c.user_id
     AND EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_referrer) THEN
    v_ref_award := award_points(p_referrer, 'referral_verified', c.user_id::text);
  END IF;

  RETURN jsonb_build_object('ok',true,'challenge_id',c.id,'user_id',c.user_id,
                            'wallet',lower(c.wallet_addr),'moment',p_matched_moment_id,
                            'first_verification',v_first,
                            'link_wallet_award',v_award,'referral_award',v_ref_award);
END $function$;

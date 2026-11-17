-- audit_20261115_saved_wallets_inherit_verification
--
-- 2026-11-15 (Trevor: "verify easily and effectively"). saved_wallets has one row per
-- (user, wallet, collection). Every verification path stamps ALL of a user's rows for the
-- wallet at the moment it runs (resolve_wallet_challenge_match, admin_verify_wallet,
-- markSavedWalletVerified) — but a collection row saved LATER arrived unverified, so the
-- same wallet read verified on one row and unverified on another (Trevor's own 0xbd94…
-- had an unverified Golazos row from 09-12 under a June attestation). This trigger makes a
-- newly inserted row inherit the user's existing verification for that wallet, for every
-- writer (resolve-and-associate, saved-wallets, any future one) at once.
--
-- Address match: exact, plus a case-folded match ONLY for a Flow hex address (0x + 16 hex).
-- A Solana base58 key is case-sensitive and is never folded (CLAUDE.md "Chain two").
-- Runs as the inserting role (not SECURITY DEFINER): service_role sees every row; an
-- authenticated writer under RLS sees only its own rows, which are the only ones it needs.
--
-- Revert: DROP TRIGGER saved_wallets_inherit_verification_trg ON public.saved_wallets;
--         DROP FUNCTION public.saved_wallets_inherit_verification();

CREATE OR REPLACE FUNCTION public.saved_wallets_inherit_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_at timestamptz;
  v_method text;
BEGIN
  IF NEW.verified_at IS NULL AND NEW.user_id IS NOT NULL AND NEW.wallet_addr IS NOT NULL THEN
    SELECT sw.verified_at, sw.verification_method
      INTO v_at, v_method
      FROM public.saved_wallets sw
     WHERE sw.user_id = NEW.user_id
       AND sw.verified_at IS NOT NULL
       AND (
             sw.wallet_addr = NEW.wallet_addr
          OR (NEW.wallet_addr ~* '^0x[0-9a-f]{16}$' AND lower(sw.wallet_addr) = lower(NEW.wallet_addr))
           )
     ORDER BY sw.verified_at
     LIMIT 1;
    IF v_at IS NOT NULL THEN
      NEW.verified_at := v_at;
      NEW.verification_method := v_method;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- anon-exec: revoked (saved_wallets_inherit_verification) — new trigger fn; EXECUTE is checked only at CREATE TRIGGER, so nobody needs it.
REVOKE EXECUTE ON FUNCTION public.saved_wallets_inherit_verification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS saved_wallets_inherit_verification_trg ON public.saved_wallets;
CREATE TRIGGER saved_wallets_inherit_verification_trg
  BEFORE INSERT ON public.saved_wallets
  FOR EACH ROW EXECUTE FUNCTION public.saved_wallets_inherit_verification();

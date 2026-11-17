-- audit_20260914: the verification_method CHECK refuses the value the signature path writes
--
-- 🚨 CAUGHT BY A POSITIVE CONTROL, NOT BY A TEST. 2e1e0ee shipped
-- resolve_wallet_signature_match writing verification_method = 'wallet_signature'.
-- saved_wallets carries saved_wallets_verification_method_check, which allows only
--   NULL | fcl_dapper | fcl_blocto | fcl_other | listing_challenge | owner_attested
-- so the FIRST REAL VERIFICATION would have raised 23514 and the route would have
-- surfaced it as a 500. The unit suite cannot see this — it never touches the DB —
-- and the guard inside the function (wallet_not_saved) returns before the UPDATE,
-- so a control that stops there reads clean. Only exercising the write finds it.
--
-- ⓘ Note what the list already contains: fcl_dapper / fcl_blocto / fcl_other. RPC
-- had FCL wallet sign-in before it was removed on 2026-08-08. The column has been
-- ready for this the whole time; only the vocabulary was missing a term for
-- "proved by signature, wallet-agnostic".
--
-- WHY A NEW TERM rather than reusing fcl_dapper: the signature path is not
-- Dapper-specific — FCLCrypto.verifyUserSignatures answers for any FCL wallet —
-- and recording every signature as Dapper's would misattribute the proof. The
-- three fcl_* values describe WHICH WALLET CONNECTED; 'wallet_signature' describes
-- HOW CONTROL WAS PROVED, which is the question this column is asked.
--
-- Additive: the constraint only widens, so no existing row can be invalidated and
-- nothing that writes the old values changes behaviour.
--
-- REVERT:
--   ALTER TABLE public.saved_wallets DROP CONSTRAINT saved_wallets_verification_method_check;
--   ALTER TABLE public.saved_wallets ADD CONSTRAINT saved_wallets_verification_method_check
--     CHECK (verification_method IS NULL OR verification_method = ANY (ARRAY[
--       'fcl_dapper','fcl_blocto','fcl_other','listing_challenge','owner_attested']));
--   (safe only while no row holds 'wallet_signature' — check first.)

-- Fail loudly rather than silently widening past a row we did not expect.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM saved_wallets
   WHERE verification_method IS NOT NULL
     AND verification_method NOT IN ('fcl_dapper','fcl_blocto','fcl_other',
                                     'listing_challenge','owner_attested','wallet_signature');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'saved_wallets holds % row(s) outside the intended vocabulary; widen deliberately, do not sweep', v_bad;
  END IF;
END $$;

ALTER TABLE public.saved_wallets
  DROP CONSTRAINT IF EXISTS saved_wallets_verification_method_check;

ALTER TABLE public.saved_wallets
  ADD CONSTRAINT saved_wallets_verification_method_check
  CHECK (
    verification_method IS NULL
    OR verification_method = ANY (ARRAY[
      'fcl_dapper'::text,
      'fcl_blocto'::text,
      'fcl_other'::text,
      'listing_challenge'::text,
      'owner_attested'::text,
      'wallet_signature'::text
    ])
  );

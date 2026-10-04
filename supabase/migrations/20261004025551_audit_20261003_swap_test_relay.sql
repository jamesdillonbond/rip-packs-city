-- audit_20261003: relay for the admin-only TWO-SIGNER SWAP TEST (Trevor, 2026-10-03:
-- "Do it all", approving docs/strategy/trading-revisit-2026-10-03.md §6).
--
-- One swap transaction needs two Flow Wallets' signatures, and one browser session
-- can be connected to only one wallet. The initiator's session (wallet A) builds and
-- submits the transaction; when FCL asks for wallet B's payload signature, it posts
-- the signable here, and the co-signer's session (wallet B, another browser or a
-- phone) reads it, has wallet B sign, and posts the signature back. Rows live for
-- one transaction (~10 min reference-block window). Service role only, through
-- /api/admin/swap-test (RPC_ADMIN_TOKEN). No functions, no pg_cron.
--
-- Revert: DROP TABLE public.swap_test_relay; (needs an interactively confirmed statement).

CREATE TABLE IF NOT EXISTS public.swap_test_relay (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cosigner       text NOT NULL CHECK (cosigner ~ '^0x[0-9a-f]{16}$'),
  signable       jsonb NOT NULL,
  signature      text CHECK (signature IS NULL OR signature ~ '^[0-9a-f]{128}$'),
  key_id         int  CHECK (key_id IS NULL OR key_id >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  signed_at      timestamptz,
  -- a signature always carries the key that made it
  CONSTRAINT swap_test_relay_signed_has_key
    CHECK ((signature IS NULL AND key_id IS NULL AND signed_at IS NULL)
        OR (signature IS NOT NULL AND key_id IS NOT NULL AND signed_at IS NOT NULL))
);
ALTER TABLE public.swap_test_relay ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.swap_test_relay FROM anon, authenticated;

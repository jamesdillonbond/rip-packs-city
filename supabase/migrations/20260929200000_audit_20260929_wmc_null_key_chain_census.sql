-- 2026-09-29: per-row CHAIN verdict for every Top Shot wallet_moments_cache row with edition_key IS NULL.
-- Written by scripts/wmc-null-key-chain-census.mjs (reads each row's stored wallet on mainnet:
-- is the moment id in the wallet's Top Shot collection, its All Day collection, both, or neither).
-- Evidence for the delete in 20260929201000_audit_20260929_delete_wmc_allday_ids_in_topshot_cache.
CREATE TABLE IF NOT EXISTS public.audit_20260929_wmc_null_key_chain_census (
  id uuid PRIMARY KEY,
  wallet_address text NOT NULL,
  moment_id text NOT NULL,
  chain text NOT NULL CHECK (chain IN ('ts', 'ad', 'both', 'none')),
  checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260929_wmc_null_key_chain_census ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260929_wmc_null_key_chain_census FROM PUBLIC, anon, authenticated;

-- 2026-09-29: delete the Top Shot wallet_moments_cache rows that /api/wallet-search wrote for ALL DAY ids
-- (code fixed the same day: "wallet-search: All Day ids never touch Top Shot").
-- Set = rows whose chain verdict in audit_20260929_wmc_null_key_chain_census is NOT in the wallet's Top Shot
-- collection ('ad' 1,646 + 'none' 33 = 1,679). The 2 'ts' rows are real unnamed Top Shot holdings and stay.
-- Re-guarded at delete time: still Top Shot, still edition_key IS NULL. Every deleted row is copied whole first.
-- Revert: INSERT INTO public.wallet_moments_cache SELECT * FROM public.audit_20260929_wmc_allday_ids_in_topshot_cache;
CREATE TABLE IF NOT EXISTS public.audit_20260929_wmc_allday_ids_in_topshot_cache AS
  SELECT * FROM public.wallet_moments_cache WITH NO DATA;
ALTER TABLE public.audit_20260929_wmc_allday_ids_in_topshot_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260929_wmc_allday_ids_in_topshot_cache FROM PUBLIC, anon, authenticated;

-- 36 wallets: zzz_guard_del_wmc blocks a multi-wallet delete unless opted in. This one is id-scoped and audited.
SET LOCAL rpc.allow_bulk_delete = on;

WITH doomed AS (
  DELETE FROM public.wallet_moments_cache w
  USING public.audit_20260929_wmc_null_key_chain_census c
  WHERE c.id = w.id
    AND c.chain IN ('ad', 'none')
    AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND w.edition_key IS NULL
  RETURNING w.*
)
INSERT INTO public.audit_20260929_wmc_allday_ids_in_topshot_cache SELECT * FROM doomed;

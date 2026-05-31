-- Phase F — drop the DEFAULT on collections.chain
--
-- This file is a PRE-STAGED DRAFT. Do NOT apply until Phase D has shipped
-- and soaked in production for 48 hours. See:
--   docs/handoff-phase-d-lib-chains-flow-reorg.md
--   docs/migrations/chain-abstraction-plan-2026-05-30.md  (§ "Phase F pre-staged SQL")
--
-- Why gated on Phase D, not Phase C:
--   Phase C made dbChain explicit at the type level in lib/collections.ts.
--   Phase D relocates Flow-specific primitives under lib/chains/flow/ —
--   when D ships and soaks, "chain dispatch lives in code" becomes
--   reliably true. Dropping the DEFAULT before D would force callers to
--   pass chain explicitly while half the data plane still doesn't know
--   about the dbChain field.
--
-- Apply (from Cowork, via Supabase MCP apply_migration tool):
--   migration name: audit_2026XXXX_collections_chain_drop_default
--   query: (the single ALTER below)
--
-- Rollback (if any unforeseen issue):
--   ALTER TABLE public.collections ALTER COLUMN chain SET DEFAULT 'flow'::chain_type;

ALTER TABLE public.collections ALTER COLUMN chain DROP DEFAULT;

-- Smoke verify post-apply:
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='collections' AND column_name='chain';
-- Expected: NULL (no default). Was: 'flow'::chain_type

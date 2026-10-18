-- 2026-10-18 9:10 AM PT (Cowork cloud; Trevor "Keep going").
-- UFC Strike's on-chain TIER trait includes "Epic" (40 sets; public.ufc_chain_set_metadata),
-- which public.tier_type lacked. Added here, alone, because a new enum value cannot be
-- used in the transaction that adds it; the UFC tier correction runs separately.
-- The enum is ordered rarest-first (ULTIMATE, LEGENDARY, RARE, UNCOMMON, ...), so EPIC goes
-- BEFORE RARE (between LEGENDARY and RARE).
-- REVERT: an enum value cannot be dropped in place; it is unused unless a row carries it
-- (SELECT count(*) FROM editions WHERE tier = 'EPIC').
ALTER TYPE public.tier_type ADD VALUE IF NOT EXISTS 'EPIC' BEFORE 'RARE';

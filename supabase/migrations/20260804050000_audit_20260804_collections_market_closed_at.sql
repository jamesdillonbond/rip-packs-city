-- audit_20260804_collections_market_closed_at
--
-- Record the collection-level fact that a secondary market has ceased trading.
-- This is a DATA fact consumed by pricing + wallet pipelines, NOT a nav flag
-- (is_active / published govern nav and must never gate data — see the Candy
-- $0-wallet incident). Presentation code has a synchronous mirror in
-- lib/market-closed.ts (keyed by URL slug) for pure/sync surfaces (seo, banners);
-- this column is the source of truth for "may a pipeline publish this as a
-- current price / fold it into a wallet total?".
--
-- Applied live via MCP apply_migration 2026-08-03 (PT).
-- Revert: ALTER TABLE public.collections DROP COLUMN market_closed_at;
ALTER TABLE public.collections ADD COLUMN IF NOT EXISTS market_closed_at timestamptz;

COMMENT ON COLUMN public.collections.market_closed_at IS
  'Date the collection''s secondary market ceased trading on the chain we index. NULL = live. Governs FMV confidence (capped at STALE) and wallet-total inclusion; NOT a nav flag.';

-- UFC Strike's Flow marketplace closed 2026-05-13 (last observed Flow sale).
UPDATE public.collections SET market_closed_at = '2026-05-13'::timestamptz
WHERE slug = 'ufc_strike' AND market_closed_at IS NULL;

-- Buyback-wallet analytics primitive.
--
-- topshot_insider_buybacks holds 205k rows at ~10.6x redundancy for analytics
-- purposes; the natural grain for every question asked of it (spend over a
-- period, who they bought from, what they bought most) is
-- (buyer, day, method, edition, seller). That collapses to ~19.8k rows, small
-- enough to aggregate live for ANY period without the 5.8s seq scan the base
-- table costs.
--
-- CRITICAL SEMANTICS captured in the columns, not in prose:
--   acquisitions        - always known.
--   priced_acquisitions - the subset carrying a price. For the main buyback
--                         wallet (0x4d2c9216f1dca098) this is ZERO on every
--                         row: its 161,366 acquisitions are snapshot_diff
--                         detections with NULL price AND NULL seller. So
--                         spend for that wallet is UNKNOWABLE, not zero, and
--                         any consumer MUST carry priced_acquisitions beside
--                         spend_usd so a reader can tell a real $0 from an
--                         unpriced acquisition. Summing spend_usd alone
--                         reports the buyback programme as ~$0.05/moment.
--   activity_date       - for snapshot_diff rows sold_at is midnight-pinned to
--                         the DETECTION date, not a trade time. Day grain is
--                         therefore the finest honest resolution available.
--
-- Revert: DROP MATERIALIZED VIEW IF EXISTS public.topshot_buyback_daily CASCADE;
CREATE MATERIALIZED VIEW IF NOT EXISTS public.topshot_buyback_daily AS
SELECT
  b.buyer_address,
  ((b.sold_at AT TIME ZONE 'UTC')::date)      AS activity_date,
  b.acquisition_method,
  b.edition_id,
  NULLIF(b.seller_address, '')                AS seller_address,
  count(*)::int                               AS acquisitions,
  count(b.price_usd)::int                     AS priced_acquisitions,
  sum(b.price_usd)                            AS spend_usd
FROM public.topshot_insider_buybacks b
GROUP BY 1, 2, 3, 4, 5;

-- Unique index is REQUIRED for REFRESH ... CONCURRENTLY. NULLS NOT DISTINCT
-- because edition_id and seller_address are both legitimately NULL (unresolved
-- edition; snapshot-diff rows have no counterparty at all).
CREATE UNIQUE INDEX IF NOT EXISTS ux_topshot_buyback_daily_grain
  ON public.topshot_buyback_daily
  (buyer_address, activity_date, acquisition_method, edition_id, seller_address)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_topshot_buyback_daily_date
  ON public.topshot_buyback_daily (activity_date DESC);

CREATE INDEX IF NOT EXISTS idx_topshot_buyback_daily_edition
  ON public.topshot_buyback_daily (edition_id) WHERE edition_id IS NOT NULL;

-- A materialized view cannot carry RLS and cannot be security_invoker, so the
-- anon/authenticated grants must be revoked EXPLICITLY. Per CLAUDE.md,
-- REVOKE ... FROM PUBLIC alone does NOT strip Supabase's default per-role
-- grant, and this database additionally carries ALTER DEFAULT PRIVILEGES
-- granting to anon/authenticated -- so revoke all three in one statement.
REVOKE ALL ON public.topshot_buyback_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.topshot_buyback_daily TO service_role;

COMMENT ON MATERIALIZED VIEW public.topshot_buyback_daily IS
  'Daily-grain rollup of topshot_insider_buybacks for buyback-wallet analytics. '
  'priced_acquisitions MUST travel beside spend_usd: the main buyback wallet has '
  'zero priced rows, so spend is unknowable rather than zero. Refreshed daily by '
  'refresh_topshot_buyback_daily() after the institutional snapshot diff.';

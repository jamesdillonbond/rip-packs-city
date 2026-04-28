// Response shapes for the canonical Flowty analytics RPCs.
//
// These types are not in lib/database.types.ts because the
// flowty_analytics_* RPCs and the flowty_funded_loans /
// flowty_limbo_loans / flowty_open_listings views were added after
// the last Supabase types regen. They will be reflected on the next
// regeneration; until then the route handlers cast .data to these
// interfaces directly.

export interface AnalyticsCollectionBreakdownEntry {
  count: number
  usd: number
}

export interface AnalyticsSummaryWindow {
  total_loans: number
  total_principal_usd: number
  total_repayment_usd: number
  unique_lenders: number
  unique_borrowers: number
  // Term rate is the lender-set rate over the loan term (avg ~77 days);
  // avg_apr is the same rate annualized: term_rate × (365 / term_days).
  // Some older callers still read avg_interest_rate — keep it as an alias
  // so existing code paths don't break during the transition.
  avg_term_rate: number | null
  avg_interest_rate?: number | null
  avg_apr: number | null
  avg_term_days: number | null
  active_count: number
  repaid_count: number
  settled_count: number
  // Lifetime default rate as a percent: settled / (repaid + settled).
  default_rate_pct: number | null
  open_listings_count: number
  open_listings_principal: number
  active_loans_count: number
  outstanding_principal: number
  expected_repayment: number
  // Per-collection roll-up: keys are collection slugs ("topshot", "allday",
  // "golazos", "pinnacle", "ufc", "other"). Values: { count, usd }.
  collection_breakdown?: Record<string, AnalyticsCollectionBreakdownEntry>
  // The repeat-pct fields only appear when p_start_at is non-null
  // (i.e. for windowed queries). They are absent for lifetime queries.
  lender_repeat_pct?: number | null
  borrower_repeat_pct?: number | null
}

export interface AnalyticsSummaryResponse extends AnalyticsSummaryWindow {
  prior_period: AnalyticsSummaryWindow | null
}

export interface AnalyticsTimeseriesRow {
  bucket: string // YYYY-MM-DD
  collection: string
  loan_count: number
  principal_usd: number
  repayment_usd: number
}

export interface AnalyticsLeaderboardRow {
  rank: number
  addr: string
  loan_count: number
  total_principal_usd: number
  total_repayment_usd: number
  is_returning: boolean
  first_seen_at: string | null
  last_seen_at: string | null
}

export interface AnalyticsNewWalletsRow {
  week: string // YYYY-MM-DD
  new_borrowers: number
  new_lenders: number
  cumulative_total: number
}

export interface AnalyticsCohortRow {
  cohort_month: string // YYYY-MM-01
  cohort_size: number
  month_offset: number
  active_count: number
  retention_pct: number
}

export interface AnalyticsLimboSummary {
  // Legacy aggregate counts — kept for callers that haven't migrated yet.
  total_loans: number
  repaid_count: number
  settled_count: number
  canceled_count: number
  repayment_rate_pct: number
  unique_borrowers: number
  unique_lenders: number
  window_start: string | null
  window_end: string | null
  // Refined breakdown of pre-window terminations vs. the official Flowty
  // Limbo Loan grace period (Jan 30 - Feb 13 2026). The original framing
  // double-counted normal repayments during the settlement-pause window
  // as "limbo recovery"; these fields disambiguate.
  total_pre_window_loans?: number
  pre_reopen_terminations?: number
  grace_period_terminations?: number
  grace_period_settlements?: number
  grace_period_repayments?: number
  post_grace_tail?: number
  long_after?: number
  data_freshness_hours?: number
}

// Per-wallet detail RPC response — see flowty_analytics_wallet_detail.
// Both as_borrower and as_lender are present even for wallets that have
// only ever appeared in one role; the unused side has zeroed counters.

export interface WalletRoleStats {
  loan_count: number
  active_count: number
  repaid_count: number
  settled_count: number
  total_principal_usd: number
  total_repayment_usd: number
  default_rate_pct: number | null
  unique_lenders?: number
  unique_borrowers?: number
  avg_loan_size_usd: number
  avg_term_days?: number
  avg_apr?: number
  first_seen_at: string | null
  last_seen_at: string | null
}

export interface WalletLimboStats {
  loan_count: number
  repaid_count: number
  settled_count: number
  first_terminal: string | null
  last_terminal: string | null
}

export interface WalletRecentLoan {
  nft_id: number
  status: string
  funded_at: string
  repaid_at: string | null
  settled_at: string | null
  matures_at: string | null
  collection: string
  term_seconds: number
  interest_rate: number
  principal_usd: number
  repayment_usd: number
  principal_amount: number
  repayment_amount: number
  principal_currency: string
  counterparty_addr: string
  funding_resource_id: number
  listing_resource_id: number
}

export interface WalletDetailResponse {
  addr: string
  is_active: boolean
  as_borrower: WalletRoleStats
  as_lender: WalletRoleStats
  limbo_as_borrower: WalletLimboStats
  limbo_as_lender: WalletLimboStats
  borrower_collection_breakdown: Record<string, { loan_count: number; principal_usd: number }>
  lender_collection_breakdown: Record<string, { loan_count: number; principal_usd: number }>
  recent_as_borrower: WalletRecentLoan[]
  recent_as_lender: WalletRecentLoan[]
}

export interface WalletDirectoryRow {
  addr: string
  borrower_loan_count: number
  lender_loan_count: number
  borrower_principal_usd: number
  lender_principal_usd: number
  primary_role: "borrower" | "lender" | "mixed"
  last_active_at: string
}

// ── Sales analytics RPC response shapes ─────────────────────────────────────
// analytics_sales_summary, analytics_sales_timeseries, analytics_sales_leaderboard,
// analytics_sales_top_moves. Marketplace values are: "topshot" (centralized
// Top Shot marketplace), "flowty" (Flowty's NFTStorefrontV2 fork), "on-chain"
// or "pinnacle" (direct Pinnacle.Trade events).

export interface SalesCollectionBreakdownEntry {
  count: number
  usd: number
}

export interface SalesMarketplaceBreakdownEntry {
  count: number
  usd: number
}

export interface SalesSummaryWindow {
  total_sales: number
  total_volume_usd: number
  unique_buyers: number
  unique_sellers: number
  avg_price_usd: number | null
  median_price_usd: number | null
  p90_price_usd: number | null
  max_price_usd: number | null
  collection_breakdown?: Record<string, SalesCollectionBreakdownEntry>
  marketplace_breakdown?: Record<string, SalesMarketplaceBreakdownEntry>
}

export interface SalesSummaryResponse extends SalesSummaryWindow {
  prior_period: SalesSummaryWindow | null
}

export interface SalesTimeseriesRow {
  bucket: string // YYYY-MM-DD
  collection: string
  sale_count: number
  volume_usd: number
  avg_price_usd: number | null
}

export interface SalesLeaderboardRow {
  rank: number
  addr: string
  sale_count: number
  total_volume_usd: number
  avg_price_usd: number | null
  is_returning: boolean
  first_seen_at: string | null
  last_seen_at: string | null
}

export interface SalesTopMoveRow {
  rank: number
  collection: string
  serial_number: number | null
  price_usd: number
  buyer_address: string | null
  seller_address: string | null
  marketplace: string
  sold_at: string
  player_name: string | null
  set_name: string | null
  edition_id: string | null
  moment_id: number | null
  transaction_hash: string | null
}

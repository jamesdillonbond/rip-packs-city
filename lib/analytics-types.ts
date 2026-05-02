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

// ── Pulse RPC response shapes ───────────────────────────────────────────────
// analytics_pulse_24h, analytics_pulse_activity, analytics_pulse_hourly.
// Pulse is the live activity stream — loan + sale events combined.

export interface PulseLoansSection {
  originations: number
  repayments: number
  settlements: number
  origination_volume_usd: number
}

export interface PulseSalesSection {
  sales: number
  volume_usd: number
  unique_buyers: number
  avg_price_usd: number | null
  max_price_usd: number | null
}

export interface PulsePriorLoans {
  originations: number
  origination_volume_usd: number
}

export interface PulsePriorSales {
  sales: number
  volume_usd: number
}

export interface Pulse24hResponse {
  loans: PulseLoansSection
  sales: PulseSalesSection
  prior_loans: PulsePriorLoans
  prior_sales: PulsePriorSales
  as_of: string
}

// kind values: loan_originated | loan_repaid | loan_settled | sale.
// details is a kind-specific jsonb blob — the dashboard knows the shape per kind.
export type PulseActivityKind =
  | "loan_originated"
  | "loan_repaid"
  | "loan_settled"
  | "sale"

export interface PulseActivityRow {
  occurred_at: string
  kind: PulseActivityKind
  collection: string
  primary_addr: string | null
  counterparty: string | null
  amount_usd: number | null
  details: Record<string, unknown>
}

export interface PulseHourlyRow {
  hour: string // ISO timestamp at hour boundary
  loan_count: number
  loan_volume_usd: number
  sale_count: number
  sale_volume_usd: number
}

// ── Listings RPC response shapes ────────────────────────────────────────────
// analytics_listings_summary + analytics_listings_open_loan_offers.
// "Listings" surfaces what's currently buyable / offered, not historical sales.

export interface ListingsLoanOffersSection {
  count: number
  total_principal_usd: number
  avg_principal_usd: number | null
  avg_apr: number | null
  avg_term_days: number | null
  collections?: Record<string, { count: number; total_principal_usd: number }>
}

export interface ListingsTopShotOrderbookSection {
  count: number
  min_ask_usd: number | null
  median_ask_usd: number | null
  p90_ask_usd: number | null
  max_ask_usd: number | null
  avg_ask_usd: number | null
  total_ask_usd: number | null
  locked_count: number
}

export interface ListingsMarketplaceCollectionEntry {
  collection: string
  count: number
  min_ask_usd: number | null
  max_ask_usd: number | null
  avg_ask_usd: number | null
  median_ask_usd: number | null
}

export interface ListingsSummaryResponse {
  loan_offers: ListingsLoanOffersSection
  topshot_orderbook: ListingsTopShotOrderbookSection
  marketplace_listings: ListingsMarketplaceCollectionEntry[]
  data_caveats?: string[] | null
  as_of: string
}

export interface ListingsOpenLoanOfferRow {
  listing_resource_id: string | number
  collection: string
  borrower_addr: string | null
  // Always populated — the storefront resource (typically a child account in
  // a HybridCustody hierarchy) that hosts the listing on-chain.
  storefront_address: string
  // True when borrower_addr was resolved via the historical HybridCustody
  // parent map; false when the FUNDING_AVAILABLE event explicitly carried a
  // borrower address. Null borrower_addr means the storefront is first-time
  // and hasn't been seen on a funded loan elsewhere yet.
  borrower_inferred: boolean
  principal_usd: number
  principal_currency: string | null
  interest_rate: number | null
  apr_pct: number | null
  term_days: number | null
  expires_at: string | null
  listed_at: string | null
  nft_id: string | number | null
}

// ── FMV RPC response shapes ────────────────────────────────────────────────
// analytics_fmv_pipeline_health, analytics_fmv_top_movers, analytics_fmv_tier_pulse.

export interface FmvPipelineCollectionStats {
  editions_total: number
  high_confidence: number
  medium_confidence: number
  low_confidence: number
  ask_only: number
  reliable_total_fmv_usd: number
  reliable_avg_fmv_usd: number
  last_refresh: string | null
  minutes_since_refresh: number | null
}

export interface FmvPipelineHealthResponse {
  collections: Record<string, FmvPipelineCollectionStats>
  as_of: string
  note?: string | null
}

export type FmvConfidence = "HIGH" | "MEDIUM" | "LOW" | "ASK_ONLY"

export interface FmvTopMoverRow {
  rank: number
  collection: string
  edition_id: string
  player_name: string | null
  set_name: string | null
  current_fmv_usd: number
  prior_fmv_usd: number | null
  change_usd: number
  change_pct: number
  current_confidence: FmvConfidence
  prior_confidence: FmvConfidence | null
  sales_count_7d: number
}

export interface FmvTierPulseRow {
  collection: string
  tier: string | null
  edition_count: number
  total_fmv_usd: number
  avg_fmv_usd: number | null
  median_fmv_usd: number | null
  high_conf_count: number
  low_conf_count: number
}

// ── Sets RPC response shapes ───────────────────────────────────────────────
// analytics_sets_summary, analytics_sets_directory, analytics_sets_detail,
// analytics_sets_series_overview. The Sets surface is a catalog view —
// rollups across sets/editions joined to FMV — and is intentionally
// read-mostly (revalidate 600).

export interface SetsTierBreakdown {
  common: number
  fandom: number
  rare: number
  legendary: number
  ultimate: number
}

export interface SetsCollectionSummary {
  set_count: number
  edition_count: number
  tier_breakdown: SetsTierBreakdown
}

export interface SetsSummaryResponse {
  collections: {
    topshot?: SetsCollectionSummary
    allday?: SetsCollectionSummary
    golazos?: SetsCollectionSummary
    ufc?: SetsCollectionSummary
  }
  as_of: string
  note?: string | null
}

export type SetsDirectorySort =
  | "value_desc"
  | "value_asc"
  | "name_asc"
  | "newest"
  | "completion_desc"

export interface SetsDirectoryRow {
  collection: string
  set_id: string
  set_external_id: string | null
  set_name: string
  series: number | null
  edition_count: number
  edition_count_with_fmv: number
  coverage_pct: number
  median_fmv_usd: number | null
  total_fmv_usd: number
  total_fmv_robust_usd: number
  avg_fmv_usd: number | null
  max_edition_fmv_usd: number | null
  outlier_flag: boolean
  earliest_minted_at: string | null
}

export interface SetsDetailEdition {
  edition_id: string
  edition_external_id: string | null
  name: string | null
  tier: string | null
  circulation_count: number | null
  series: number | null
  play_type: string | null
  thumbnail_url: string | null
  first_minted_at: string | null
  fmv_usd: number | null
  fmv_confidence: FmvConfidence | null
}

export interface SetsDetailResponse {
  set_id: string
  set_external_id: string | null
  set_name: string
  series: number | null
  tier: string | null
  collection: string
  editions: SetsDetailEdition[]
  as_of: string
}

export interface SetsSeriesOverviewRow {
  collection: string
  series: number | null
  series_label: string
  set_count: number
  edition_count: number
  edition_count_with_fmv: number
  median_edition_fmv: number | null
  total_series_fmv_robust: number
}

// ── Wallets overview RPC response ─────────────────────────────────────────
// analytics_wallets_overview. Hub-level rollup over the loan-book wallet
// directory — totals, segments by peak volume, and activity recency cohorts.

export interface WalletsOverviewTotals {
  wallets_total: number
  borrowers: number
  lenders: number
  both_roles: number
  total_borrowed_usd: number
  total_lent_usd: number
  avg_loans_per_borrower: number
  avg_loans_per_lender: number
  last_active_within_24h: number
  last_active_within_7d: number
  dormant_30d: number
}

export interface WalletsOverviewSegments {
  whale: number
  active: number
  casual: number
  dust: number
}

export interface WalletsOverviewResponse {
  totals: WalletsOverviewTotals
  segments: WalletsOverviewSegments
  as_of: string
}

// ── Position-transfer RPC response shapes ──────────────────────────────────
// analytics_wallet_position_transfers + analytics_position_transfers_summary.
// HybridCustody parent/child reassignment causes a small fraction of FULL
// loans to settle to a lender address that differs from the origination
// lender. These RPCs surface that delta on the wallet profile and the
// loans dashboard.

export type WalletPositionTransferStatus =
  | "active"
  | "repaid"
  | "settled"
  | "canceled"
  | string

export interface WalletPositionTransferOutgoingLoan {
  listing_resource_id: string | number
  collection: string
  borrower_addr: string
  recipient_addr: string
  principal_usd: number
  funded_at: string
  settled_at: string | null
  status: WalletPositionTransferStatus
}

export interface WalletPositionTransferIncomingLoan {
  listing_resource_id: string | number
  collection: string
  borrower_addr: string
  origin_addr: string
  principal_usd: number
  funded_at: string
  settled_at: string | null
  status: WalletPositionTransferStatus
}

export interface WalletPositionTransfersResponse {
  addr: string
  outgoing: {
    count: number
    principal_usd: number
    unique_recipients: number
    loans: WalletPositionTransferOutgoingLoan[]
  }
  incoming: {
    count: number
    principal_usd: number
    unique_origins: number
    loans: WalletPositionTransferIncomingLoan[]
  }
  has_activity: boolean
  as_of: string
}

export interface PositionTransfersSummaryTotals {
  total_transfers: number
  total_principal_usd: number
  unique_origin_lenders: number
  unique_recipient_lenders: number
  pct_of_full_loans: number
}

export interface PositionTransfersTopWallet {
  addr: string
  transfers: number
  principal_usd: number
}

export interface PositionTransfersRecentRow {
  listing_resource_id: string | number
  collection: string
  origin_addr: string
  recipient_addr: string
  principal_usd: number
  funded_at: string
  status: WalletPositionTransferStatus
}

export interface PositionTransfersSummaryResponse {
  totals: PositionTransfersSummaryTotals
  top_origins: PositionTransfersTopWallet[]
  top_recipients: PositionTransfersTopWallet[]
  recent: PositionTransfersRecentRow[]
  as_of: string
  note?: string | null
}

// ── Pipeline health RPC response shape ─────────────────────────────────────
// analytics_pipeline_health. Summarizes lag for each upstream pipeline
// powering the analytics surface.

export type PipelineHealthStatus = "healthy" | "degraded" | "stale"

export interface PipelineHealthRow {
  lag_minutes: number
  expected_max_lag_min: number
  status: PipelineHealthStatus
  cadence: string
}

export interface PipelineHealthResponse {
  pipelines: {
    loans: PipelineHealthRow
    sales: PipelineHealthRow
    fmv: PipelineHealthRow
    pack_ev: PipelineHealthRow
    listings: PipelineHealthRow
  }
  overall_status: PipelineHealthStatus
  as_of: string
}

// ── Lender performance RPC response shape ──────────────────────────────────
// analytics_lender_performance. Realized-yield ranking of lenders with
// settled or repaid loans. Active loans are excluded.

export interface LenderPerformanceRow {
  rank: number
  addr: string
  total_loans: number
  total_principal_usd: number
  repaid_loans: number
  repaid_principal_usd: number
  repaid_collected_usd: number
  interest_earned_usd: number
  default_loans: number
  default_principal_usd: number
  realized_yield_pct: number | null
  default_rate_pct: number | null
  active_loans: number
}

// ── Username resolution responses ──────────────────────────────────────────
// analytics_resolve_usernames + analytics_lookup_username. Public mapping
// from wallet address to NBA Top Shot username (or other source).

export interface ResolveUsernamesResponse {
  usernames: Record<string, string>
}

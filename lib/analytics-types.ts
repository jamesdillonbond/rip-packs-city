// Response shapes for the canonical Flowty analytics RPCs.
//
// These types are not in lib/database.types.ts because the
// flowty_analytics_* RPCs and the flowty_funded_loans /
// flowty_limbo_loans / flowty_open_listings views were added after
// the last Supabase types regen. They will be reflected on the next
// regeneration; until then the route handlers cast .data to these
// interfaces directly.

export interface AnalyticsSummaryWindow {
  total_loans: number
  total_principal_usd: number
  total_repayment_usd: number
  unique_lenders: number
  unique_borrowers: number
  avg_interest_rate: number | null
  avg_term_days: number | null
  active_count: number
  repaid_count: number
  settled_count: number
  open_listings_count: number
  open_listings_principal: number
  active_loans_count: number
  outstanding_principal: number
  expected_repayment: number
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
  total_loans: number
  repaid_count: number
  settled_count: number
  canceled_count: number
  repayment_rate_pct: number
  window_start: string | null
  window_end: string | null
  unique_borrowers: number
  unique_lenders: number
}

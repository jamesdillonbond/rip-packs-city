// Methodology entries — each describes how a metric is computed,
// what data sources back it, and how often it refreshes.

export interface MethodologyEntry {
  slug: string
  title: string
  blurb: string
  paragraphs: string[]
  sources: string[]
  refresh: string
}

export const METHODOLOGY: Record<string, MethodologyEntry> = {
  loans: {
    slug: "loans",
    title: "Loans Methodology",
    blurb: "How we compute the Flowty loan book and its derived metrics.",
    paragraphs: [
      "Flowty loan data is ingested directly from Flow mainnet chain events emitted by the Flowty contract at A.5c57f79c6694797f.Flowty. Each loan begins life as a LoanListed event and progresses through LoanFunded, LoanRepaid, LoanSettled, or LoanCancelled events. We materialize one row per loan in flowty_loans, plus a chronological audit trail in flowty_loan_events. Aggregate metrics are computed by canonical Postgres RPCs — flowty_analytics_summary, flowty_analytics_timeseries, flowty_analytics_leaderboard, flowty_analytics_new_wallets, flowty_analytics_cohorts, and flowty_analytics_limbo_summary — backed by three views (flowty_funded_loans, flowty_limbo_loans, flowty_open_listings) so every chart and KPI in the dashboard agrees on a single source of truth.",
      "Coverage starts at approximately Dec 29 2025, when the Flow exploit recovery spork created the earliest accessible blocks for the rebuilt Flowty contract. Loans funded before that date appear in our data only when their terminal event (repaid or settled) lands inside our window — we call this the &quot;Limbo cohort&quot; and surface it separately on the dashboard. Originated-in-window KPIs and the Limbo cohort are kept distinct because mixing them was the main source of inflated metrics in earlier versions of the dashboard.",
      "principal_usd is normalized only for stablecoin loans (USDCf, USDC, FUSD, TUSDT, DUC) since these all peg 1:1 with USD. FLOW-denominated loans (currently only 2 in our data) are excluded from USD aggregates pending oracle integration. Interest rate is the lender-set rate at the time of funding; we report a simple unweighted mean across loans in the requested window. Settled loans are treated as a default-rate proxy — they represent collateral seized after a missed repayment. The lender_at_settlement field tracks position transfers via HybridCustody but is not currently surfaced in the dashboard.",
      "New-wallet acquisition compares the address sets per role per period. A wallet is counted as new in a window if its earliest funded_at across the entire history falls inside that window. Cohorts are monthly and assigned by earliest activity month; retention is the percentage of a cohort with at least one loan in each subsequent month. Cohorts switched from quarterly to monthly because our backfill window is only ~120 days, which would collapse all activity into a single quarterly bucket.",
    ],
    sources: [
      "flowty_loans (Supabase) — one row per funded loan, materialized from chain events emitted by A.5c57f79c6694797f.Flowty on Flow mainnet",
      "flowty_loan_events (Supabase) — full event audit trail",
      "flowty_funded_loans / flowty_limbo_loans / flowty_open_listings (Supabase views) — canonical lifecycle slices consumed by the analytics RPCs",
      "Flow access node block range scanner",
    ],
    refresh: "Every 10 minutes",
  },
  fmv: {
    slug: "fmv",
    title: "FMV Methodology",
    blurb: "How we compute fair-market-value for every edition.",
    paragraphs: [
      "FMV is computed per edition — uniquely identified by setID:playID for Top Shot and equivalent composites for other collections. We use a weighted-average price (WAP) of recent on-chain sales, with weight decaying linearly over a configurable lookback window (default 60 days). We currently apply WAP combined with two diagnostic features — days-since-last-sale and 30-day sales count — to compute confidence.",
      "Confidence is bucketed HIGH, MEDIUM, or LOW based on sample size and price dispersion. HIGH requires at least 12 sales in the window with price standard deviation below a tier-aware threshold. MEDIUM and LOW reflect sparser or noisier samples and should be treated with appropriate caution.",
      "Per-moment serial premiums and badge premiums are layered on top of edition FMV using regression-fit multipliers. The base FMV applies to a hypothetical median-serial moment with no premium badges; serial-1 and jersey-match moments receive a multiplicative premium calibrated against historical sales of similarly badged editions.",
    ],
    sources: [
      "sales (Supabase, year-partitioned) — on-chain sales indexed from chain events",
      "fmv_snapshots (Supabase) — most recent FMV per edition with confidence",
      "Flowty market data for ask-side validation",
    ],
    refresh: "Every 20 minutes",
  },
  retention: {
    slug: "retention",
    title: "Retention & Cohort Methodology",
    blurb: "How we build cohorts and measure repeat behavior across analytics.",
    paragraphs: [
      "Cohorts are monthly (loans) or quarterly (other modules) and assigned by earliest activity. For loans, an address joins a cohort in the month of its first funded loan in the requested role (lender or borrower). For sales and other modules, the cohort assignment is the quarter of the address&apos;s earliest indexed event of the relevant kind. Loans cohorts switched from quarterly to monthly because our post-spork backfill window is only ~120 days; a quarterly granularity would collapse all activity into one row.",
      "Retention is computed as the % of a cohort that has at least one event of the relevant kind in each subsequent period. We do not require continuous activity — a member who returned in M3 but not M2 still counts as retained for M3. This is the &quot;classic&quot; retention curve and matches industry-standard SaaS cohort definitions.",
      "Repeat percentages on the live KPI strip use a slightly different definition — a wallet is &quot;returning&quot; in the current window if it had any prior activity at any earlier date. This catches all re-engagement, not just consecutive-quarter retention.",
    ],
    sources: [
      "flowty_loans (Supabase)",
      "sales (Supabase) — once Sales module ships",
    ],
    refresh: "Every 10 minutes (loans) / 20 minutes (sales)",
  },
}

export const METHODOLOGY_LIST = Object.values(METHODOLOGY)

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
      "Flowty loan data is ingested directly from Flow mainnet chain events emitted by the Flowty contract at A.5c57f79c6694797f.Flowty. Each loan begins life as a LoanListed event and progresses through LoanFunded, LoanRepaid, LoanSettled, or LoanCancelled events. We materialize one row per loan in flowty_loans, plus a chronological audit trail in flowty_loan_events. Aggregate metrics are computed by canonical Postgres RPCs — flowty_analytics_summary, flowty_analytics_timeseries, flowty_analytics_leaderboard, flowty_analytics_new_wallets, flowty_analytics_cohorts, flowty_analytics_limbo_summary, flowty_analytics_wallet_detail, and flowty_analytics_wallet_directory — backed by three views (flowty_funded_loans, flowty_limbo_loans, flowty_open_listings) so every chart and KPI in the dashboard agrees on a single source of truth.",
      "Coverage starts at approximately Dec 29 2025, when the Flow exploit recovery spork created the earliest accessible blocks for the rebuilt Flowty contract. Pre-Dec 28 2025 history lives in pre-spork blocks and would require a custom spork-proxy backfill (planned as V2). &quot;Pre-window loan closures&quot; represent loans whose origination events predate our scan window — we only see their terminal events: repaid, settled, or canceled. The official Flowty Limbo Loan repayment grace period (Jan 30 – Feb 13 2026) accounts for 348 of the 1,679 pre-window terminations: 118 settlements (the actual platform-recovery number) plus 230 grace-period repayments. The rest were normal repayments during the settlement-pause window (1,127 in the pre-reopen period) or post-grace tails. 98% of pre-window activity is concentrated in 3 power-user wallets, so the cohort isn&apos;t broadly representative — it&apos;s a power-user story, not a community recovery.",
      "principal_usd is normalized only for stablecoin loans (USDCf, USDC, FUSD, TUSDT, DUC, all 1:1 with USD). The 2 FLOW-denominated loans currently in our data are excluded from USD aggregates pending oracle integration. Avg APR is annualized as term_rate × (365 / term_days), not the raw rate-over-term — a 23% rate on a 77-day loan is ~110% APR, which is the more honest comparison metric. The dashboard shows both. Default rate is calculated as settled / (repaid + settled), excluding active and listed loans (they haven&apos;t had the chance to settle yet). Lifetime is currently around 4.6%; the L30 window typically reads 0% because most recent loans are still active.",
      "lender_at_settlement tracks position transfers via HybridCustody (mostly main-wallet → child-wallet patterns) and currently flags about 23 loans, but is not surfaced in the dashboard. New-wallet acquisition compares the address sets per role per period — a wallet is counted as new in a window if its earliest funded_at across the entire history falls inside that window. Cohorts are monthly and assigned by earliest activity month; cohort cells show the % of that cohort active in month N (not strict retention — wallets can come back after a gap). Cohorts switched from quarterly to monthly because our backfill window is only ~120 days, which would otherwise collapse all activity into a single quarterly bucket.",
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
      "Retention is computed as the % of a cohort that has at least one event of the relevant kind in each subsequent period. We do not require continuous activity — a member who returned in M3 but not M2 still counts as &quot;active in M3.&quot; This is the &quot;classic&quot; retention curve and matches industry-standard SaaS cohort definitions. The cohort heatmap is labeled accordingly: &quot;% active in month N,&quot; not strict retention.",
      "Repeat percentages on the live KPI strip use a slightly different definition — a wallet is &quot;returning&quot; in the current window if it had any prior activity at any earlier date. This catches all re-engagement, not just consecutive-quarter retention.",
    ],
    sources: [
      "flowty_loans (Supabase)",
      "sales (Supabase) — once Sales module ships",
    ],
    refresh: "Every 10 minutes (loans) / 20 minutes (sales)",
  },
  "default-rate": {
    slug: "default-rate",
    title: "Default Rate Methodology",
    blurb: "How we compute the default rate on the loan analytics dashboard.",
    paragraphs: [
      "Only loans that have reached a terminal state count toward the default rate. Active loans are excluded — they haven&apos;t had the chance to settle yet, so including them would artificially deflate the rate. Listed (un-funded) loans are also excluded by definition.",
      "&quot;Settled&quot; means the lender invoked Flowty.settleFunding(...) after the loan matured unrepaid, claiming the NFT collateral. &quot;Repaid&quot; means the borrower (or autopayment) returned the principal plus interest before maturity. Cancellations (LoanCancelled events) reflect a borrower withdrawing the listing before funding and are excluded from the rate calculation entirely — they were never a credit decision.",
      "The rate is computed as settled / (repaid + settled), expressed as a percentage. Lifetime sits around 4.62% as of the latest cutoff. Windowed views (L30, L90) commonly read close to 0% because most recent loans are still active and haven&apos;t had time to either repay or settle.",
      "Pre-window loan closures are tracked separately. The 118 grace-period settlements during Flowty&apos;s official Limbo Loan window (Jan 30 – Feb 13 2026) are not folded into the lifetime default rate, since those loans were originated before our scan window and represent a different credit cohort. They&apos;re surfaced on the dashboard&apos;s &quot;Pre-window loan closures&quot; section instead.",
    ],
    sources: [
      "flowty_funded_loans (Supabase view) — denominator (repaid + settled)",
      "flowty_loans (Supabase) — terminal state per loan",
      "flowty_analytics_summary RPC — default_rate_pct field",
    ],
    refresh: "Every 10 minutes",
  },
  "wallet-profiles": {
    slug: "wallet-profiles",
    title: "Wallet Profile Methodology",
    blurb: "How wallet profile pages are built and what they include.",
    paragraphs: [
      "Each wallet profile page aggregates the wallet&apos;s role-specific stats (as borrower and as lender) plus pre-window activity (loans whose origination predates our scan window — we only see terminal events). Both roles render even if only one is populated, with a &quot;Pre-window only&quot; badge when the wallet&apos;s entire history sits in the pre-window cohort.",
      "Primary role classification (lender / borrower / mixed) is determined by which role has more loan count. Mixed surfaces only when both sides have funded-window activity, since pre-window-only activity isn&apos;t a strong signal of intent.",
      "Wallets are crawlable — each profile is a standalone page in the sitemap with schema.org Person and Dataset markup. Recent loan rows include counterparty links to their own profile pages, so a crawler walking the directory can discover the entire graph. There is no opt-out for indexability today, since on-chain addresses are public; we can implement one if requested via the dashboard&apos;s feedback channel.",
      "Username resolution falls back through saved_wallets (display_name → username → truncated 0x...). As Trevor and other users save wallets with custom names, those propagate to the profile page&apos;s heading and to counterparty links across the dashboard.",
    ],
    sources: [
      "flowty_analytics_wallet_detail (Supabase RPC) — per-wallet role-specific stats and recent loans",
      "flowty_analytics_wallet_directory (Supabase RPC) — directory index",
      "saved_wallets (Supabase) — username resolution",
    ],
    refresh: "Every 10 minutes (ISR)",
  },
}

export const METHODOLOGY_LIST = Object.values(METHODOLOGY)

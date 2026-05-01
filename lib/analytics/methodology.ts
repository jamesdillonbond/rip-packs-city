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
      "Flowty loan data is ingested directly from Flow mainnet chain events emitted by the Flowty contract at A.5c57f79c6694797f.Flowty. Each loan begins life as a LoanListed event and progresses through LoanFunded, LoanRepaid, LoanSettled, or LoanCancelled events. We materialize one row per loan in flowty_loans, plus a chronological audit trail in flowty_loan_events. Aggregate metrics are computed by canonical Postgres RPCs — flowty_analytics_summary, flowty_analytics_timeseries, flowty_analytics_leaderboard, flowty_analytics_new_wallets, flowty_analytics_cohorts, flowty_analytics_limbo_summary, flowty_analytics_wallet_detail, and flowty_analytics_wallet_directory — backed by three views (flowty_funded_loans, flowty_limbo_loans, flowty_open_listings) so every chart and KPI in the dashboard agrees on a single source of truth. The analytics surface now includes a Sales section as a sibling — see /analytics/methodology/sales for the parallel sales pipeline.",
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
  sales: {
    slug: "sales",
    title: "Sales Methodology",
    blurb: "How we index secondary-market sales across Flow collectibles platforms.",
    paragraphs: [
      "Sales are aggregated from five chain-event sources into a unified Postgres view. NBA Top Shot's centralized marketplace contributes the bulk of volume via TopShotMarketV3.MomentPurchased events. NFL All Day and LaLiga Golazos are populated from their respective Sold / MomentPurchased events. UFC Strike contributes pre-Aptos history. Disney Pinnacle direct sales come from on-chain Pinnacle.Trade events. Flowty's secondary marketplace is indexed from the NFTStorefrontV2 fork at 0x3cdbb3d569211ff3 (a separate deployment from Dapper's NFTStorefrontV2 at 0x4eb8a10cb9f87357). All five feed the canonical analytics_sales_* RPC family — analytics_sales_summary, analytics_sales_timeseries, analytics_sales_leaderboard, and analytics_sales_top_moves — so every dashboard reading agrees on a single source of truth.",
      "Coverage runs from Dec 14 2025 onward (~94K sales as of late April 2026). Earlier history sits in pre-spork blocks and would require the V2 spork-proxy backfill to capture. The Sales section is a sibling of /analytics/loans — they query disjoint tables but share the same window helper, retry helper, and FilterBar component.",
      "Buyer/seller anonymity caveat. Top Shot's centralized marketplace doesn't expose participant wallets — the ~49,141 L30 Top Shot marketplace sales all have NULL buyer_address. Aggregate volume and sale counts are honest (we do see the price + moment), but the leaderboards reflect Flowty + Pinnacle direct activity only, since those are the marketplaces that emit on-chain participant identities. The dashboard surfaces an info banner directly under the KPI strip explaining this so readers don't misread the leaderboard rankings as universal.",
      "Marketplace breakdown semantics. The marketplace column takes three canonical values: \"topshot\" (centralized Top Shot marketplace, biggest by volume), \"flowty\" (Flowty's NFTStorefrontV2 fork — secondary marketplace covering Top Shot, AllDay, Golazos), and \"on-chain\" (or \"pinnacle\", merged in the dashboard) for direct Pinnacle.Trade sales. The marketplace mix component renders these as a stacked bar with dollar volume per slice in the legend.",
      "Collection slug normalization. Sales tables historically used various collection identifiers — nba_top_shot, nfl_all_day, etc. — that don't match the loans table convention. The unified view normalizes them at materialization time: nba_top_shot → topshot, nfl_all_day → allday, laliga_golazos → golazos, ufc_strike → ufc, disney_pinnacle → pinnacle. After this normalization the same FilterBar collection chips work for both Loans and Sales without any per-section wiring.",
      "Platform contract exclusion. The analytics_sales_leaderboard RPC always filters out platform contract addresses — Flowty escrow, Dapper merchant, Pinnacle.Trade contracts, and lending escrows — because those addresses are aggregators, not retail traders, and would always rank #1 by total flow if included. The exclusion list is hardcoded inside the RPC and not exposed via query string (the route hardcodes p_include_contracts=false). If you need contract-inclusive rankings, query the RPC directly.",
      "The probe edge function flowty-spork-probe (deployed for V2 development) is no longer needed once spork-proxy.tdillonbond.workers.dev returns real Flow data. It can be deleted after V2 ships.",
    ],
    sources: [
      "sales (Supabase, year-partitioned 2020–2026) — chain-event-indexed sales for Top Shot, AllDay, Golazos, UFC",
      "pinnacle_sales (Supabase) — on-chain Pinnacle.Trade events",
      "flowty_transactions (Supabase) — NFTStorefrontV2 fork at 0x3cdbb3d569211ff3",
      "Unified sales view + analytics_sales_* RPC family",
    ],
    refresh: "Every 10 minutes",
  },
  fmv: {
    slug: "fmv",
    title: "FMV Methodology",
    blurb: "How we compute fair-market-value for every edition.",
    paragraphs: [
      "FMV is computed per edition — uniquely identified by setID:playID for Top Shot and the equivalent composite key for NFL All Day. The base figure is an outlier-filtered weighted average price (WAP) of recent on-chain sales, layered with serial multipliers and a liquidity rating. Both the sales feed and the listing feed are inputs — sales drive the headline price, listings drive the validation and the ask-only fallback when there are no sales to anchor against. The current FMV algo is v1.5.1, which adds days-since-last-sale and 30-day sales count as diagnostic features alongside the WAP.",
      "Confidence is bucketed HIGH, MEDIUM, LOW, or ASK_ONLY. HIGH means 5+ recent sales with low price variance — this is the cohort the dashboard's reliable totals key off of. MEDIUM is 2-4 recent sales, still trustworthy but with wider error bars. LOW is one recent sale or interpolated from a comparable edition. ASK_ONLY means we have no recent sales at all and the FMV is derived from the lowest live ask. Per-moment serial premiums and badge premiums are layered on top of the edition base FMV using regression-fit multipliers — the base FMV applies to a hypothetical median-serial moment with no premium badges.",
      "Aggregates exclude ASK_ONLY editions. Listing-reward farming asks at $100K-$1M pollute the lowest-ask signal — wallets list moments at absurd prices to qualify for marketplace participation rewards, and those listings exist on-chain but are not real prices. Including ASK_ONLY editions in pipeline totals or top-movers tables would mostly surface farming noise. The Pipeline Health card shows the ASK_ONLY count for transparency, but every total/avg/median figure on the dashboard is computed over HIGH+MEDIUM+LOW only.",
      "Refresh cadence is approximately 10 minutes — the FMV pipeline runs continuously and recomputes per-edition snapshots as new sales land. The Top Movers table compares the current snapshot against the snapshot from N days ago (1, 7, or 30) and orders by % change. Movers where current_confidence is LOW and sales_count_7d is zero are flagged with a thin-data warning icon — those rows are the most likely to be noise (a single $0.18 sale that pumped to $12 will read as a +6,000% gainer but is not a real price discovery signal). Pinnacle, Golazos, and UFC are out of scope for this section: Pinnacle uses a separate pinnacle_fmv_snapshots pipeline, while Golazos and UFC don't yet have FMV at all.",
    ],
    sources: [
      "sales (Supabase, year-partitioned 2020–2026) — chain-event-indexed sales for Top Shot and All Day",
      "fmv_snapshots (Supabase) — most recent FMV per edition with confidence",
      "ts_listings + cached_listings (Supabase) — ask-side validation and ASK_ONLY fallback",
      "analytics_fmv_pipeline_health / analytics_fmv_top_movers / analytics_fmv_tier_pulse RPCs",
    ],
    refresh: "Every ~10 minutes",
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
  pulse: {
    slug: "pulse",
    title: "Pulse Methodology",
    blurb: "How the live activity feed is built and how often it refreshes.",
    paragraphs: [
      "The Pulse activity feed combines four event streams into a single time-ordered timeline — Flowty loan originations (FUNDING_AVAILABLE events), loan terminations (FUNDING_REPAID and FUNDING_SETTLED events), and marketplace sales (Top Shot TopShotMarketV3.MomentPurchased, Flowty NFTStorefrontV2.ListingCompleted, and direct Pinnacle.Trade events). Every event is keyed by occurred_at and rendered most-recent-first. The 24h summary at the top of the page uses a rolling window pinned to the latest event we have, not a calendar-day boundary, so it always reflects the last 24 hours of recorded activity.",
      "Refresh cadence varies by source. The loan side runs about 10 minutes behind chain tip — Flowty events are scanned in 250-block chunks and materialized into flowty_loans on a 10-min cron. Sales are typically 5-15 minutes behind, depending on whether they came from on-chain event indexing (Flowty + Pinnacle direct) or marketplace ingestion (centralized Top Shot). The Pulse page itself auto-refreshes every 30 seconds in the browser, so the freshest events surface as soon as the underlying tables get them.",
      "Sale events from Top Shot's centralized marketplace appear without buyer or seller wallet addresses — that marketplace doesn't expose participant identities. Those rows render with an \"Anonymous · centralized\" badge so the missing addresses don't read as a bug. Aggregate volume, sale count, and price are accurate; only the counterparty side is opaque. Flowty + Pinnacle sales include full buyer/seller wallets and both link to /analytics/wallets/[address] profile pages.",
      "Filtering is applied at the RPC layer — the kinds parameter accepts any subset of loan_originated, loan_repaid, loan_settled, sale, and the collections parameter accepts the same normalized slugs as Loans and Sales (topshot, allday, golazos, ufc, pinnacle). The optional Min size filter is applied client-side after fetch and just hides rows whose amount_usd falls below the threshold — useful for de-noising the $1 trade chatter on Top Shot. The activity list keeps at most the 100 most recent events; older items scroll off the bottom.",
    ],
    sources: [
      "flowty_loans + flowty_loan_events (Supabase) — origination, repayment, settlement timeline",
      "sales (Supabase, year-partitioned) — Top Shot, AllDay, Golazos, UFC indexed sales",
      "pinnacle_sales (Supabase) — Pinnacle.Trade direct sales",
      "flowty_transactions (Supabase) — NFTStorefrontV2 fork at 0x3cdbb3d569211ff3",
      "analytics_pulse_24h / analytics_pulse_activity / analytics_pulse_hourly RPCs",
    ],
    refresh: "Activity feed: 30s in browser. Underlying data: 10 min (loans) / 5-15 min (sales)",
  },
  listings: {
    slug: "listings",
    title: "Listings Methodology",
    blurb: "How the open-offer table and orderbook samples are built.",
    paragraphs: [
      "The Listings dashboard pulls from two distinct data sources that should not be conflated. flowty_open_listings is a complete, real-time view of every open Flowty loan offer — when a borrower posts a loan listing, it appears in this view; when the listing is funded, canceled, or expires, it disappears. The open-offer count and total liquidity figures are exact representations of the Flowty lending order book. There's no sampling involved on this side.",
      "cached_listings and ts_listings are the marketplace ask side and are explicitly subsets, not full orderbook snapshots. Both are populated by the Sniper deal-feed scanner, which walks each marketplace looking for below-FMV inventory worth surfacing as deals. Top Shot orderbook depth is sampled to roughly 100-200 listings on each scan; cached_listings holds the same shape across NFL All Day, Golazos, and others. Median ask is the most representative summary statistic on these tables — min and max can be skewed by listing-reward farming asks, and the dataset is small enough that count alone doesn't tell the full story.",
      "Both sources are filtered through the dead-listing rule before they hit the dashboard: any ask above 50× FMV (or above $100,000 when no FMV is available) is excluded. This catches the listing-reward farming pattern where wallets list a moment at $9 million to earn micro-rewards from being a marketplace participant — those listings exist on-chain but are not real prices. Without the filter the orderbook stats would be unreadable.",
      "APR on loan offers is annualized for honest comparison. The Flowty contract emits a term_rate (the rate over the loan term, typically 30-90 days) and we convert via term_rate × (365 / term_days). A 23% rate on a 77-day loan is ~110% APR, which is the more useful comparison metric — the dashboard surfaces only the annualized figure, not the raw term rate. Collections are filtered through the same normalization used elsewhere (nba_top_shot → topshot, nfl_all_day → allday, laliga_golazos → golazos, etc.) so the FilterBar chips work identically across Loans, Sales, Pulse, and Listings.",
      "Borrower resolution via HybridCustody. Flowty's ListingAvailable event identifies the storefront resource (typically a child account in a HybridCustody hierarchy), not the parent wallet that ultimately receives the loan. We resolve storefront → parent borrower by mapping each storefront we observe in past funded loans to its parent wallet. About 73% of currently-listed offers resolve via this lookup; the remaining 27% are first-time storefronts that will resolve once they get their first funded loan. Open-offer rows expose both addresses — the borrower wallet (linked to the wallet profile when known) plus the storefront address used as the fallback identifier when the parent hasn't been seen yet.",
    ],
    sources: [
      "flowty_open_listings (Supabase view) — real-time open Flowty loan offers",
      "ts_listings (Supabase) — Sniper-feed-sampled Top Shot marketplace asks",
      "cached_listings (Supabase) — Sniper-feed-sampled marketplace asks for AllDay, Golazos, others",
      "fmv_snapshots (Supabase) — for the 50× FMV dead-listing filter",
      "analytics_listings_summary / analytics_listings_open_loan_offers RPCs",
    ],
    refresh: "Every 5 minutes (page revalidate)",
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
      "The /analytics/wallets index is now a hub — above the per-wallet directory grid, the page renders a roll-up powered by analytics_wallets_overview. The KPI strip shows total wallets, active-7d, total volume, and average loans per active wallet. Volume-tier segments slice the directory four ways: Whales ($50K+ peak volume), Active ($5K+), Casual ($100+), and Dust (under $100). Role buckets and recency cohorts (24h / 7d / dormant 30d+) sit beside the segment bar. The borrowed-equals-lent invariant holds at the platform level: every dollar borrowed is a dollar lent, so total_borrowed_usd == total_lent_usd in the totals — the KPI strip surfaces the borrowed figure as &quot;Total volume&quot; with a sublabel calling out the invariant. Wallets that act as both borrower and lender count once in wallets_total but appear in both role buckets, so borrowers + lenders − both = wallets_total.",
    ],
    sources: [
      "flowty_analytics_wallet_detail (Supabase RPC) — per-wallet role-specific stats and recent loans",
      "flowty_analytics_wallet_directory (Supabase RPC) — directory index",
      "analytics_wallets_overview (Supabase RPC) — hub-level totals, segments, recency cohorts",
      "saved_wallets (Supabase) — username resolution",
    ],
    refresh: "Every 10 minutes (ISR)",
  },
  sets: {
    slug: "sets",
    title: "Sets Methodology",
    blurb: "How the catalog rollups, series eras, and per-set FMV totals are built.",
    paragraphs: [
      "Sets are the unit of organization above editions on Flow collectibles platforms — every edition belongs to one set, and sets in turn belong to a collection (NBA Top Shot, NFL All Day, LaLiga Golazos, UFC Strike). The /analytics/sets surface joins the canonical sets and editions tables to fmv_snapshots and exposes four roll-ups: a per-collection summary (set / edition counts plus a tier mix), a series overview (one row per series era with edition counts and total robust FMV), a per-set directory (sortable, filterable table of every set with FMV coverage), and a per-set detail page with the full editions list. All four are powered by the analytics_sets_* RPC family — analytics_sets_summary, analytics_sets_directory, analytics_sets_detail, and analytics_sets_series_overview.",
      "Coverage is the percent of editions in a set that have a reliable FMV — i.e. an FMV snapshot at HIGH, MEDIUM, or LOW confidence. ASK_ONLY editions and editions with no snapshot don&apos;t count. The directory exposes a min-coverage filter (0% / 50% / 75% / 100%) so users can collapse the table to well-covered sets when they want to compare apples-to-apples, and surfaces the raw coverage as a small bar visualization next to each row.",
      "The robust total caps each per-edition FMV at 20× the set median before summing. This is the headline number on every Sets surface — directory rows, series chart, per-set hero card. The cap exists because a small fraction of editions carry listing-reward farming asks orders of magnitude above true price, and including those raw figures makes set totals unreadable. We still expose the raw total alongside the robust total on the per-set detail page so users can see both figures, but the dashboard reaches for robust as the primary value (e.g. Genesis at $1.01M raw is much higher than the robust total — the difference is the outlier cap doing its job). The outlier_flag column is true on directory rows where any edition exceeds 20× the set median; the row gets a subtle amber tint and a warning icon with the explanation.",
      "Pinnacle is excluded from /analytics/sets because Pinnacle&apos;s catalog has a different set structure — collection sets vs shape vs variant — that doesn&apos;t map cleanly onto the sets/editions schema the other four platforms share. Pinnacle has its own analytics surface elsewhere; folding it into Sets would require a separate adapter we haven&apos;t built. UFC Strike is included for completeness even though it migrated to Aptos in 2024 — the historical Flow catalog still has 3 sets / 147 editions and shows up here because users still hold those moments.",
      "Top Shot series labels are canonical and ordered: Series 1 (on-chain series=0), Series 2 (=2), Summer 2021 (=3), Series 3 (=4), Series 4 (=5), Series 2023-24 (=6), Series 2024-25 (=7), Series 2025-26 (=8). Note that on-chain series=1 doesn&apos;t exist — series=0 IS Series 1. Editions tagged with series=1 in our catalog are anomalous (mostly UUID-imported rows that didn&apos;t carry a real series tag at hydrate time); they render under a &quot;Misc / Unmapped&quot; label with an info tooltip explaining the anomaly. The Misc bucket usually shows low or zero FMV because most of those editions don&apos;t have FMV computed yet. That&apos;s correct behavior — surface them but they shouldn&apos;t pollute the headline numbers, and the chart sorts them last.",
      "Freshness: FMV refreshes approximately every 10 minutes via the standard pipeline; the set + edition catalog itself updates daily as new sets/editions land on chain. The per-set detail pages use ISR with a 6-hour revalidate; the top-100 most valuable sets are pre-rendered at build via generateStaticParams so the highest-traffic detail pages are fast on first request, and the rest fall through to ISR.",
    ],
    sources: [
      "sets (Supabase) — one row per set across the four supported collections",
      "editions (Supabase) — joined to sets for catalog roll-ups",
      "fmv_snapshots (Supabase) — most recent reliable FMV per edition",
      "analytics_sets_summary / analytics_sets_directory / analytics_sets_detail / analytics_sets_series_overview RPCs",
    ],
    refresh: "FMV every ~10 min · catalog daily · per-set detail ISR every 6h",
  },
}

export const METHODOLOGY_LIST = Object.values(METHODOLOGY)

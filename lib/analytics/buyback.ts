// Types and pure display logic for the Top Shot buyback-wallet analytics
// surface (/analytics/buyback, backed by /api/analytics/buyback).
//
// ── WHY THIS BOARD IS SMALL, AND WHY THAT IS THE HONEST ANSWER ──────────────
// The first version of this surface published 161,797 "moments acquired". That
// number was an artifact. It came from the direct_transfer arm of
// topshot_insider_buybacks, which is produced by diffing consecutive daily
// wallet-holdings snapshots -- and that wallet walk is unstable, so the wallet's
// own existing stock drops out of one snapshot and reappears in the next, which
// the diff reads as an arrival. Measured 2026-08-16:
//
//   * 41,301 of 41,307 distinct moments it reported as acquired were ALREADY
//     HELD on the first snapshot. Only six were ever genuinely new.
//   * 62-86% of daily "arrivals" were present in the wallet two days earlier.
//   * 0 of 200 sampled ever appear in `sales` (positive control: 208/208
//     marketplace rows do resolve on the same key).
//   * Holdings sit flat at ~52,120 while the table claimed ~6,500/day.
//
// So the board now counts ONLY verified marketplace purchases -- rows carrying a
// sale_id from the sales_2026 trigger. That is 431 rows, not 161,797. A small
// true number beats a large false one, and `coverage.excluded_*` states what was
// removed so the surface can explain its own size rather than implying the
// buyback programme is inactive.
//
// The second rule this module keeps intact: an acquisition we could not price is
// not one that cost nothing, so `spend_usd` never travels without
// `priced_purchases` beside it.

/** Calendar-to-date windows the API accepts. Mirrors BUYBACK_PERIODS. */
export type BuybackPeriod = "week" | "month" | "year" | "all"

export interface BuybackTotals {
  purchases: number
  priced_purchases: number
  spend_usd: number | null
  spend_known: boolean
  distinct_editions: number
  active_days: number
}

export interface BuybackCoverage {
  observation_start: string | null
  unpriced_purchases: number
  counterparty_known_for: number
  date_grain: string
  /** Holdings-snapshot rows deliberately excluded as unreliable. */
  excluded_snapshot_rows: number
  excluded_wallets: number
  excluded_reason: string | null
}

export interface BuybackWallet {
  address: string
  username: string | null
  purchases: number
  priced_acquisitions: number
  spend_usd: number | null
  distinct_editions: number
  spend_known: boolean
}

export interface BuybackEdition {
  edition_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series?: number | null
  purchases?: number
  priced_acquisitions: number
  spend_usd: number | null
}

export interface BuybackSeller {
  seller_address: string
  username: string | null
  purchases: number
  spend_usd: number | null
}

export interface BuybackDay {
  d: string
  purchases: number
  priced_acquisitions: number
  spend_usd: number | null
}

export interface BuybackPayload {
  period: BuybackPeriod
  window_start: string | null
  window_end: string | null
  basis?: string
  totals: BuybackTotals
  coverage: BuybackCoverage
  wallets: BuybackWallet[]
  top_editions_by_count: BuybackEdition[]
  top_editions_by_spend: BuybackEdition[]
  top_sellers_by_spend: BuybackSeller[]
  top_sellers_by_count: BuybackSeller[]
  timeline: BuybackDay[]
}

export const BUYBACK_PERIOD_LABELS: Record<BuybackPeriod, string> = {
  week: "This week",
  month: "This month",
  year: "This year",
  all: "All time",
}

/** The em-dash we use for "we have no figure", never "$0". */
export const NO_FIGURE = "—"

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return NO_FIGURE
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return NO_FIGURE
  return n.toLocaleString("en-US")
}

/**
 * How a wallet's spend should read.
 *
 * Returns `known: false` with an em-dash rather than "$0.00" when nothing in the
 * window carried a price — a measured-looking zero produced by our own
 * collection method is a claim we cannot support.
 */
export function walletSpendDisplay(w: BuybackWallet): {
  known: boolean
  text: string
  note: string | null
} {
  if (!w.spend_known || w.spend_usd == null) {
    return {
      known: false,
      text: NO_FIGURE,
      note: "No price recorded on-chain for these acquisitions",
    }
  }
  return { known: true, text: formatUsd(w.spend_usd), note: null }
}

/**
 * Whether the headline spend figure is only part of the story.
 *
 * Null when every purchase in the window was priced — a caveat on a complete
 * figure would cry wolf on the system working, which is its own false claim.
 */
export function spendCoverageNotice(
  totals: BuybackTotals,
  coverage: BuybackCoverage
): { headline: string; detail: string } | null {
  if (totals.purchases <= 0) return null
  if (coverage.unpriced_purchases <= 0) return null

  return {
    headline: `Spend is known for ${formatCount(totals.priced_purchases)} of ${formatCount(
      totals.purchases
    )} purchases`,
    detail:
      `${formatCount(coverage.unpriced_purchases)} purchase(s) in this window carry no ` +
      `on-chain price. Those are real acquisitions with an unknown cost — not free ones.`,
  }
}

/**
 * The disclosure that explains why this board is small.
 *
 * Without it a reader sees "41 purchases this week" and concludes Top Shot has
 * nearly stopped buying, when in fact we discarded 39,048 unreliable rows. The
 * count is stated so the omission is auditable rather than merely asserted.
 *
 * Null when nothing was excluded — the note must not outlive the problem.
 */
export function exclusionNotice(
  coverage: BuybackCoverage
): { headline: string; detail: string } | null {
  if (!coverage.excluded_snapshot_rows || coverage.excluded_snapshot_rows <= 0) return null
  return {
    headline: `${formatCount(
      coverage.excluded_snapshot_rows
    )} holdings-snapshot movements excluded as unreliable`,
    detail:
      coverage.excluded_reason ??
      "Holdings-snapshot movements are excluded because the wallet walk is unstable; " +
        "only verified marketplace purchases are counted.",
  }
}

/**
 * Copy for the "all time" window.
 *
 * Our verified-purchase history starts at `observation_start`; the buyback
 * wallets were operating before that. Labelling the window "all time" without
 * saying so implies we are showing the programme's whole history.
 */
export function observationNotice(
  period: BuybackPeriod,
  coverage: BuybackCoverage
): string | null {
  if (!coverage.observation_start) return null
  if (period !== "all") return null
  return (
    `Verified purchases tracked since ${coverage.observation_start} — the buyback wallets ` +
    `were operating before we began capturing priced purchases, so "all time" means "all ` +
    `tracked time", not the programme's full history.`
  )
}

/** Short wallet display: @username when resolved, else a truncated address. */
export function walletLabel(address: string, username: string | null): string {
  if (username && username.trim() !== "") return username
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

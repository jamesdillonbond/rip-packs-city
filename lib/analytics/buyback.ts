// Types and pure display logic for the Top Shot buyback-wallet analytics
// surface (/analytics/buyback, backed by /api/analytics/buyback).
//
// The logic here exists to keep ONE distinction intact all the way to the
// screen: an acquisition we could not price is not an acquisition that cost
// nothing. 99.7% of the buyback programme's acquisitions reach us through a
// daily holdings-snapshot diff that carries no price and no counterparty, so a
// surface that renders `spend_usd ?? 0` publishes "$0" for 161,366 real
// purchases — a claim about Top Shot's spending manufactured entirely out of our
// own collection method.
//
// These are pure functions over the API payload so they can be unit-tested
// without rendering, and so the rule lives in one place rather than being
// re-derived at each of the ~8 sites that show a dollar figure.

/** Calendar-to-date windows the API accepts. Mirrors BUYBACK_PERIODS. */
export type BuybackPeriod = "week" | "month" | "year" | "all"

export interface BuybackTotals {
  acquisitions: number
  priced_acquisitions: number
  spend_usd: number | null
  spend_known: boolean
  distinct_editions: number
  active_days: number
}

export interface BuybackCoverage {
  observation_start: string | null
  unpriced_acquisitions: number
  unpriced_share_pct: number | null
  counterparty_known_for: number
  date_grain: string
}

export interface BuybackWallet {
  address: string
  username: string | null
  acquisitions: number
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
  acquisitions?: number
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
  acquisitions: number
  priced_acquisitions: number
  spend_usd: number | null
}

export interface BuybackPayload {
  period: BuybackPeriod
  window_start: string | null
  window_end: string | null
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
 * `spend_known` is false when NOTHING in the window carried a price, which for
 * the main buyback wallet is every window. Returning "$0.00" there would be a
 * measured-looking zero produced by our collection method, so the caller gets an
 * explicit `known: false` plus copy that names the reason.
 *
 * Note the deliberate asymmetry: a wallet that DID trade on the marketplace and
 * genuinely spent nothing is impossible here (a priced row has a price), so
 * `known: true` with a zero total is safe to render as $0.00.
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
      note: "Acquired by direct transfer — no price is recorded on-chain for these",
    }
  }
  return { known: true, text: formatUsd(w.spend_usd), note: null }
}

/**
 * Whether the headline spend figure is only part of the story, and by how much.
 *
 * Returns null when every acquisition in the window was priced — in that case
 * the spend total is complete and a caveat would cry wolf on the system working,
 * which is its own false claim.
 */
export function spendCoverageNotice(
  totals: BuybackTotals,
  coverage: BuybackCoverage
): { headline: string; detail: string } | null {
  if (totals.acquisitions <= 0) return null
  if (coverage.unpriced_acquisitions <= 0) return null

  const pct =
    coverage.unpriced_share_pct != null
      ? `${coverage.unpriced_share_pct}%`
      : `${formatCount(coverage.unpriced_acquisitions)} of ${formatCount(totals.acquisitions)}`

  return {
    headline: `Spend is known for ${formatCount(totals.priced_acquisitions)} of ${formatCount(
      totals.acquisitions
    )} acquisitions`,
    detail:
      `${pct} of moments in this window arrived by direct transfer, which carries no price ` +
      `and no counterparty on-chain. Those are real acquisitions with an unknown cost — not ` +
      `free ones. Dollar figures and the seller leaderboard below describe only the ` +
      `${formatCount(totals.priced_acquisitions)} marketplace purchase(s) we can price.`,
  }
}

/**
 * Copy for the "all time" window.
 *
 * Our snapshot history starts at `observation_start`; the main buyback wallet
 * already held 52,118 moments before that. Labelling the window "all time"
 * without saying so implies we are showing the programme's whole history.
 */
export function observationNotice(
  period: BuybackPeriod,
  coverage: BuybackCoverage
): string | null {
  if (!coverage.observation_start) return null
  if (period !== "all") return null
  return (
    `Tracked since ${coverage.observation_start} — the buyback wallets were already ` +
    `holding moments before we began snapshotting them, so "all time" means "all ` +
    `tracked time", not the programme's full history.`
  )
}

/** Short wallet display: @username when resolved, else a truncated address. */
export function walletLabel(address: string, username: string | null): string {
  if (username && username.trim() !== "") return username
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

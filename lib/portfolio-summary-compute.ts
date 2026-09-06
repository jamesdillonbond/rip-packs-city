// portfolio-summary-compute — pure adapter/aggregation logic lifted out of
// components/collection/PortfolioSummary.tsx so it lands under the vitest
// coverage `include` (lib/**), which does NOT measure components/**. No
// React/JSX, no browser globals — behavior is identical to the inline IIFEs it
// replaced.

// Authoritative wallet-wide summary from /api/wallet-summary (null until loaded).
export type WalletSummary = {
  wallet_fmv: number
  /** 2026-09-06: the STALE share of wallet_fmv (get_wallet_summary.stale_fmv); the headline is wallet_fmv − stale_fmv. */
  stale_fmv?: number
  stale_count?: number
  unlocked_fmv: number
  unlocked_count: number
  locked_fmv: number
  locked_count: number
  cost_basis: number
  current_fmv: number
  pnl: number
} | null

// Client-computed page totals (fallback when walletSummary hasn't loaded).
export type PortfolioTotals = {
  totalFmv: number
  totalBestOffer: number
  lockedFmv: number
  unlockedFmv: number
  totalCount: number
  lockedCount: number
  unlockedCount: number
}

// Minimal structural row shape — MomentRow[] satisfies this.
export type PortfolioMomentRow = {
  flowId?: string | null
  fmv?: number | null
  costBasis?: number | null
  acquisitionMethod?: string | null
  loanPrincipal?: number | null
}

export type WalletStatRowValues = {
  walletFmv: number | null
  unlockedFmv: number | null
  unlockedCount: number | null
  lockedFmv: number | null
  lockedCount: number | null
  bestOfferTotal: number | null
  spreadGap: number | null
  momentCount: number | null
  /** Stale-priced share excluded from walletFmv (0 when unknown). */
  staleFmv: number
  staleCount: number
  /**
   * 2026-09-06: true when walletFmv is a RAW total (the wallet-summary read did
   * not arrive, so the stale split is unknown and could not be subtracted). The
   * tile must SAY so — a raw total on one load and total − stale on the next is
   * the four-numbers-for-one-wallet defect at the scale of a single reader.
   */
  staleUnknown: boolean
}

// Adapter for <WalletStatRow/>: prefer the authoritative walletSummary when
// loaded; fall back to client-computed totals; emit null (not 0) when the data
// hasn't arrived yet so the row renders an em-dash placeholder.
//
// All Day lock state is suppressed (null → "not tracked") because its is_locked
// flags are frozen at a past manual run and TS-style locks expire — rendering a
// stale count as current would be an undetectable lie. Other collections pass 0
// (means "none locked") vs null (means "concept doesn't apply").
export function computeWalletStatRow(input: {
  walletSummary: WalletSummary
  walletTotalFmv: number | null
  totals: PortfolioTotals
  paginatedTotal: number
  collectionSlug: string
}): WalletStatRowValues {
  const { walletSummary, walletTotalFmv, totals, paginatedTotal, collectionSlug } = input

  // Headline = total − stale, stale disclosed — the same basis as the dashboard,
  // the public profile and the share card (2026-09-03/04/06). Before this the
  // Collection tab was the one surface still printing the raw sum ($87,812 vs
  // the dashboard's $50,234 + $44,039 stale for the same wallet).
  const staleFmv = walletSummary ? Math.max(0, Number(walletSummary.stale_fmv) || 0) : 0
  const staleCount = walletSummary ? Math.max(0, Number(walletSummary.stale_count) || 0) : 0
  const walletFmv: number | null = walletSummary
    ? Math.max(0, walletSummary.wallet_fmv - staleFmv)
    : walletTotalFmv !== null && walletTotalFmv > 0
      ? walletTotalFmv
      : totals.totalFmv > 0 && totals.totalCount >= paginatedTotal
        // ⚠ `totals` is the sum of the rows LOADED SO FAR. Publishing it as the
        // wallet's FMV while pages are still unloaded is a partial sum rendered
        // as a total (2026-09-06 — both server reads failed, 50 of 15,290 rows
        // summed under "WALLET FMV"). Only a complete row set may stand in.
        ? totals.totalFmv
        : null
  const unlockedFmv: number | null = walletSummary
    ? walletSummary.unlocked_fmv
    : totals.totalCount > 0
      ? totals.unlockedFmv
      : null
  const unlockedCount: number | null = walletSummary
    ? walletSummary.unlocked_count
    : totals.totalCount > 0
      ? totals.unlockedCount
      : null

  const lockUntracked = collectionSlug === "nfl-all-day"
  const lockedFmv: number | null = lockUntracked
    ? null
    : walletSummary
      ? walletSummary.locked_fmv
      : totals.totalCount > 0
        ? totals.lockedFmv
        : null
  const lockedCount: number | null = lockUntracked
    ? null
    : walletSummary
      ? walletSummary.locked_count
      : totals.totalCount > 0
        ? totals.lockedCount
        : null

  const bestOfferTotal: number | null = totals.totalBestOffer > 0 ? totals.totalBestOffer : null
  const spreadGap: number | null =
    walletFmv !== null && bestOfferTotal !== null ? walletFmv - bestOfferTotal : null
  const momentCount: number | null = paginatedTotal || totals.totalCount || null
  const staleUnknown = !walletSummary && walletFmv !== null

  return {
    staleFmv,
    staleCount,
    staleUnknown,
    walletFmv,
    unlockedFmv,
    unlockedCount,
    lockedFmv,
    lockedCount,
    bestOfferTotal,
    spreadGap,
    momentCount,
  }
}

// Loan-default callout: sum the principal lent against loan-defaulted moments
// (fall back to cost basis when principal is missing). Returns null when the
// wallet holds no loan-defaulted moments.
export function computeLoanDefaults(
  rows: readonly PortfolioMomentRow[],
): { count: number; totalPrincipal: number } | null {
  const loanRows = rows.filter((r) => r.acquisitionMethod === "loan_default")
  if (loanRows.length === 0) return null
  const totalPrincipal = loanRows.reduce((sum, r) => {
    const principal =
      typeof r.loanPrincipal === "number" && r.loanPrincipal > 0
        ? r.loanPrincipal
        : typeof r.costBasis === "number" && r.costBasis > 0
          ? r.costBasis
          : 0
    return sum + principal
  }, 0)
  return { count: loanRows.length, totalPrincipal }
}

export type CostBasisSummary = {
  totalCost: number
  totalFmv: number
  totalPl: number
  plPct: number
  count: number
  walletWide: boolean
}

// Cost basis / P&L summary. When the authoritative wallet-wide cost basis is
// present (> 0) it wins and the per-row loop only counts how many moments carry
// cost data; otherwise cost basis and current FMV are summed per-row over the
// loaded page (only rows with both a positive basis and a positive FMV). Returns
// null when there is no cost data to show (totalCost === 0).
export function computeCostBasisSummary(
  walletSummary: WalletSummary,
  rows: readonly PortfolioMomentRow[],
  costBasis: ReadonlyMap<string, { buyPrice: number }>,
): CostBasisSummary | null {
  let totalCost: number
  let totalFmv: number
  let totalPl: number
  let count = 0
  const walletWide = !!(walletSummary && walletSummary.cost_basis > 0)

  if (walletSummary && walletSummary.cost_basis > 0) {
    totalCost = walletSummary.cost_basis
    totalFmv = walletSummary.current_fmv
    totalPl = walletSummary.pnl
    for (const row of rows) {
      const cb = costBasis.get(row.flowId ?? "")
      const rowBasis = cb ? cb.buyPrice : row.costBasis ?? 0
      if (rowBasis > 0) count++
    }
  } else {
    totalCost = 0
    totalFmv = 0
    for (const row of rows) {
      const cb = costBasis.get(row.flowId ?? "")
      const rowBasis = cb ? cb.buyPrice : row.costBasis ?? 0
      if (rowBasis > 0 && row.fmv && row.fmv > 0) {
        totalCost += rowBasis
        totalFmv += row.fmv
        count++
      }
    }
    totalPl = totalFmv - totalCost
  }

  if (totalCost === 0) return null
  const plPct = totalCost > 0 ? (totalPl / totalCost) * 100 : 0
  return { totalCost, totalFmv, totalPl, plPct, count, walletWide }
}

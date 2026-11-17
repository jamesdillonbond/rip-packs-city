// portfolio-summary-compute — pure adapter/aggregation logic lifted out of
// components/collection/PortfolioSummary.tsx so it lands under the vitest
// coverage `include` (lib/**), which does NOT measure components/**. No
// React/JSX, no browser globals — behavior is identical to the inline IIFEs it
// replaced.

// Authoritative wallet-wide summary from /api/wallet-summary (null until loaded).
export type WalletSummary = {
  /** The wallet's whole moment count in this collection (get_wallet_summary). */
  total_moments?: number
  wallet_fmv: number
  /** 2026-09-06: the STALE share of wallet_fmv (get_wallet_summary.stale_fmv); the headline is wallet_fmv − stale_fmv. */
  stale_fmv?: number
  stale_count?: number
  /**
   * 2026-11-14: the stale share split by lock state (same predicates as locked_fmv / unlocked_fmv).
   * Present → the Locked / Unlocked tiles are netted of it so they sum to the headline. Absent (an
   * older get_wallet_summary) → the tiles stay gross and the row says so.
   */
  stale_locked_fmv?: number
  stale_unlocked_fmv?: number
  /**
   * 2026-11-14: the WALLET-WIDE bid total (get_wallet_edition_bid_total, one bid per held edition)
   * and the FMV / bids of exactly those editions. Absent → not known for this collection.
   */
  best_offer_total?: number
  best_offer_editions?: number
  best_offer_paired_fmv?: number
  best_offer_paired_offer?: number
  unlocked_fmv: number
  unlocked_count: number
  locked_fmv: number
  locked_count: number
  // Optional: an older deployment of get_wallet_summary does not send these.
  lock_unknown_fmv?: number
  lock_unknown_count?: number
  cost_basis: number
  current_fmv: number
  pnl: number
  // How many moments the wallet-wide cost_basis / current_fmv / pnl cover (get_wallet_summary).
  // Optional: an older deployment does not send it.
  moments_with_cost?: number
  // 2026-11-17: moments with a cost left OUT of cost_basis / current_fmv / pnl because their price
  // is STALE (the headline's rule). Optional: an older deployment does not send it.
  stale_with_cost_count?: number
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
  /** 2026-11-14: how many rows carry a best offer, and the FMV of exactly those rows. */
  offerCount?: number
  fmvWithOffer?: number
  pairedOffer?: number
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
  /** FMV whose lock state was never checked — disclosed, never folded into either side. */
  lockUnknownFmv: number | null
  lockUnknownCount: number | null
  bestOfferTotal: number | null
  /** How many moments (client sum) or editions (wallet-wide read) the Best Offer Total covers. */
  bestOfferCount: number | null
  bestOfferUnit: "editions" | "moments"
  /** FMV of the SAME moments the offer total covers, minus that total — never the whole wallet's FMV. */
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
  /** True when Locked / Unlocked are netted of the stale share, i.e. they sum to walletFmv. */
  staleNetted: boolean
}

// Adapter for <WalletStatRow/>: prefer the authoritative walletSummary when
// loaded; fall back to client-computed totals; emit null (not 0) when the data
// hasn't arrived yet so the row renders an em-dash placeholder.
//
// ⛔ THE ALL DAY SUPPRESSION IS GONE, AND IT WAS THE MIRROR DEFECT.
// This used to read: All Day lock state is suppressed (null → "not tracked")
// because its is_locked flags are "frozen at a past manual run". Re-derived
// 2026-09-13 and measurably false: All Day is 99.6% checked within 7 days,
// nothing older than 3 days, with allday-lock-refresh writing 326,787 rows a
// day — the FRESHEST lock data of any collection. The suppression was hiding
// 140,084 genuinely locked All Day moments behind "doesn't apply", which is
// this repo's documented mirror of a fabricated value: an `unknown` that is
// actually KNOWN is the same defect as a `false` that was never read.
//
// ⭐ And the replacement is not a different hardcoded list. Lock state is now
// decided PER ROW by provenance the database supplies (lock_known, from
// wallet_moments_cache.lock_checked_at — migration 20260913235902), so no
// surface has to guess from a collection slug. A per-collection allowlist is
// the guard-that-names-its-instances shape: it was right when written, wrong
// within weeks, and nothing made a noise when it went wrong.
//
// Other collections pass 0 (means "none locked") vs null (means "not loaded yet").
export function computeWalletStatRow(input: {
  walletSummary: WalletSummary
  walletTotalFmv: number | null
  totals: PortfolioTotals
  paginatedTotal: number
  collectionSlug: string
}): WalletStatRowValues {
  // ⭐ `collectionSlug` is INTENTIONALLY NOT DESTRUCTURED. It stays on the input
  // type because every caller passes it and other adapters use it — but nothing
  // in this function may read it any more. Lock state is decided per row by the
  // provenance the database supplies (`lock_known`), never by which collection
  // the wallet happens to be on. If a future edit needs the slug here, that is
  // the moment to ask whether a per-collection rule is really being reintroduced;
  // the last one silently hid 140,084 genuinely locked All Day moments.
  const { walletSummary, walletTotalFmv, totals, paginatedTotal } = input

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
  // The same completeness gate as the headline (2026-09-26): the locked /
  // unlocked tiles fell back to `totals` whenever ANY row had loaded, so with
  // the summary read failed they published page 1's sums as the wallet's.
  const totalsComplete = totals.totalCount > 0 && totals.totalCount >= paginatedTotal
  // 2026-11-14 (Trevor, "the math doesn't make sense"): the headline is total − stale, so the two
  // tiles under it are netted the same way when the summary carries the split — otherwise Locked +
  // Unlocked summed to $52,801 under a $47,657 Wallet FMV.
  const staleNetted = !!walletSummary &&
    typeof walletSummary.stale_locked_fmv === "number" &&
    typeof walletSummary.stale_unlocked_fmv === "number"
  const staleLocked = staleNetted ? Math.max(0, Number(walletSummary!.stale_locked_fmv) || 0) : 0
  const staleUnlocked = staleNetted ? Math.max(0, Number(walletSummary!.stale_unlocked_fmv) || 0) : 0
  const unlockedFmv: number | null = walletSummary
    ? Math.max(0, walletSummary.unlocked_fmv - staleUnlocked)
    : totalsComplete
      ? totals.unlockedFmv
      : null
  const unlockedCount: number | null = walletSummary
    ? walletSummary.unlocked_count
    : totalsComplete
      ? totals.unlockedCount
      : null

  const lockedFmv: number | null = walletSummary
    ? Math.max(0, walletSummary.locked_fmv - staleLocked)
    : totalsComplete
      ? totals.lockedFmv
      : null
  const lockedCount: number | null = walletSummary
    ? walletSummary.locked_count
    : totalsComplete
      ? totals.lockedCount
      : null

  // ⚠ Only the authoritative summary can supply this. The client-computed
  // `totals` fallback sums the rows LOADED SO FAR and has no provenance, so it
  // reports null (not 0) rather than claiming nothing is unverified.
  const lockUnknownFmv: number | null = walletSummary
    ? (walletSummary.lock_unknown_fmv ?? null)
    : null
  const lockUnknownCount: number | null = walletSummary
    ? (walletSummary.lock_unknown_count ?? null)
    : null

  // 2026-11-14: the offer total is a client sum over loaded rows, so it may stand only once every row
  // is loaded (the same gate as the tiles above). And its gap is measured against the FMV of the SAME
  // moments that carry an offer — "vs FMV: −$31,204" compared $16,452 of offers on some moments with
  // the FMV of the whole wallet, most of which has no offer at all.
  // The wallet-wide server figure wins whenever it is present (it never depends on how many grid
  // pages are loaded); the client sum stands in only for a complete row set.
  const serverOffer = walletSummary && typeof walletSummary.best_offer_total === "number" && walletSummary.best_offer_total > 0
    ? walletSummary
    : null
  let bestOfferTotal: number | null
  let bestOfferCount: number | null
  let spreadGap: number | null
  if (serverOffer) {
    bestOfferTotal = serverOffer.best_offer_total as number
    bestOfferCount = typeof serverOffer.best_offer_editions === "number" ? serverOffer.best_offer_editions : null
    spreadGap =
      typeof serverOffer.best_offer_paired_fmv === "number" && serverOffer.best_offer_paired_fmv > 0 &&
      typeof serverOffer.best_offer_paired_offer === "number"
        ? serverOffer.best_offer_paired_fmv - serverOffer.best_offer_paired_offer
        : null
  } else {
    bestOfferTotal = totalsComplete && totals.totalBestOffer > 0 ? totals.totalBestOffer : null
    bestOfferCount =
      bestOfferTotal !== null && typeof totals.offerCount === "number" ? totals.offerCount : null
    spreadGap =
      bestOfferTotal !== null && typeof totals.fmvWithOffer === "number" && totals.fmvWithOffer > 0 &&
      typeof totals.pairedOffer === "number"
        ? totals.fmvWithOffer - totals.pairedOffer
        : null
  }
  const bestOfferUnit: "editions" | "moments" = serverOffer ? "editions" : "moments"
  // 2026-11-07: the WALLET card's count is the WALLET's, like its FMV beside it.
  // `paginatedTotal` is the count under the active list filter — with a remembered
  // player filter (Luka Dončić) Trevor's card read "$52,573 · 593 moments" for a
  // 15,708-moment wallet. The summary's total wins; the list count is the fallback
  // only while the summary is missing (and unfiltered, it is the same number).
  const summaryTotal = walletSummary && typeof walletSummary.total_moments === "number" ? walletSummary.total_moments : null
  const momentCount: number | null = summaryTotal ?? (paginatedTotal || totals.totalCount || null)
  const staleUnknown = !walletSummary && walletFmv !== null

  return {
    staleFmv,
    staleCount,
    staleUnknown,
    staleNetted,
    walletFmv,
    unlockedFmv,
    unlockedCount,
    lockedFmv,
    lockedCount,
    lockUnknownFmv,
    lockUnknownCount,
    bestOfferTotal,
    bestOfferCount,
    bestOfferUnit,
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
  /**
   * Set only on the per-row fallback when the loaded rows do NOT cover the wallet
   * (2026-11-14): the sum is over `loaded` of `total` moments, and must say so. Null
   * when the figure is wallet-wide or the loaded rows are the whole wallet.
   */
  partial: { loaded: number; total: number } | null
  /** Wallet-wide only: moments with a cost left out because their price is STALE (0 when none or unknown). */
  staleExcluded: number
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
  // The wallet's moment count (the grid's paginated total). When the per-row fallback
  // runs — the wallet summary still loading, failed, or carrying no cost — and the
  // loaded rows are fewer than this, the sum is a page's, not the wallet's.
  walletMomentTotal?: number | null,
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
    // 2026-11-09: the count beside a WALLET-WIDE total must be wallet-wide too. Counting the
    // LOADED rows printed "27 moments with a known cost" beside a $113,123 cost basis that
    // get_wallet_summary had summed over 6,628 moments (the grid had loaded its first page).
    // Unknown (an older RPC without the field) is 0, which the panel renders with no number —
    // never a count taken from whichever page happens to be on screen.
    const n = walletSummary.moments_with_cost
    count = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0
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
  const total = typeof walletMomentTotal === "number" && Number.isFinite(walletMomentTotal) ? walletMomentTotal : null
  const partial = !walletWide && total != null && rows.length < total ? { loaded: rows.length, total } : null
  const se = walletWide ? walletSummary?.stale_with_cost_count : undefined
  const staleExcluded = typeof se === "number" && Number.isFinite(se) && se > 0 ? se : 0
  return { totalCost, totalFmv, totalPl, plPct, count, walletWide, partial, staleExcluded }
}

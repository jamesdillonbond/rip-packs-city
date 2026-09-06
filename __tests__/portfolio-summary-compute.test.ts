import { describe, it, expect } from "vitest"
import {
  computeWalletStatRow,
  computeLoanDefaults,
  computeCostBasisSummary,
  type PortfolioTotals,
  type WalletSummary,
  type PortfolioMomentRow,
} from "@/lib/portfolio-summary-compute"

// Pins the pure adapter/aggregation logic lifted out of
// components/collection/PortfolioSummary.tsx (invisible to the coverage
// ratchet). Regressions here mis-report wallet FMV / lock counts, drop the
// loan-default callout, or miscompute the cost-basis P&L block.

const zeroTotals: PortfolioTotals = {
  totalFmv: 0,
  totalBestOffer: 0,
  lockedFmv: 0,
  unlockedFmv: 0,
  totalCount: 0,
  lockedCount: 0,
  unlockedCount: 0,
}

const fullSummary: NonNullable<WalletSummary> = {
  wallet_fmv: 1000,
  unlocked_fmv: 600,
  unlocked_count: 12,
  locked_fmv: 400,
  locked_count: 8,
  cost_basis: 500,
  current_fmv: 1000,
  pnl: 500,
}

describe("computeWalletStatRow", () => {
  it("prefers authoritative walletSummary when loaded", () => {
    const r = computeWalletStatRow({
      walletSummary: fullSummary,
      walletTotalFmv: 999,
      totals: { ...zeroTotals, totalBestOffer: 200 },
      paginatedTotal: 20,
      collectionSlug: "nba-top-shot",
    })
    expect(r.walletFmv).toBe(1000)
    expect(r.unlockedFmv).toBe(600)
    expect(r.unlockedCount).toBe(12)
    expect(r.lockedFmv).toBe(400)
    expect(r.lockedCount).toBe(8)
    expect(r.bestOfferTotal).toBe(200)
    expect(r.spreadGap).toBe(800) // 1000 - 200
    expect(r.momentCount).toBe(20)
  })

  it("falls back to walletTotalFmv, then totals, then null when no summary", () => {
    // walletTotalFmv positive wins first
    expect(
      computeWalletStatRow({
        walletSummary: null,
        walletTotalFmv: 250,
        totals: { ...zeroTotals, totalFmv: 999 },
        paginatedTotal: 0,
        collectionSlug: "laliga-golazos",
      }).walletFmv,
    ).toBe(250)
    // walletTotalFmv null/zero → totals.totalFmv when > 0
    expect(
      computeWalletStatRow({
        walletSummary: null,
        walletTotalFmv: null,
        totals: { ...zeroTotals, totalFmv: 777 },
        paginatedTotal: 0,
        collectionSlug: "laliga-golazos",
      }).walletFmv,
    ).toBe(777)
    // nothing available → null
    expect(
      computeWalletStatRow({
        walletSummary: null,
        walletTotalFmv: 0,
        totals: zeroTotals,
        paginatedTotal: 0,
        collectionSlug: "laliga-golazos",
      }).walletFmv,
    ).toBeNull()
  })

  it("uses totals only when totalCount > 0, else nulls the fmv/count fields", () => {
    const withCount = computeWalletStatRow({
      walletSummary: null,
      walletTotalFmv: null,
      totals: { ...zeroTotals, totalCount: 5, unlockedFmv: 300, unlockedCount: 5, lockedFmv: 100, lockedCount: 2 },
      paginatedTotal: 0,
      collectionSlug: "nba-top-shot",
    })
    expect(withCount.unlockedFmv).toBe(300)
    expect(withCount.unlockedCount).toBe(5)
    expect(withCount.lockedFmv).toBe(100)
    expect(withCount.lockedCount).toBe(2)

    const noCount = computeWalletStatRow({
      walletSummary: null,
      walletTotalFmv: null,
      totals: zeroTotals,
      paginatedTotal: 0,
      collectionSlug: "nba-top-shot",
    })
    expect(noCount.unlockedFmv).toBeNull()
    expect(noCount.unlockedCount).toBeNull()
    expect(noCount.lockedFmv).toBeNull()
    expect(noCount.lockedCount).toBeNull()
  })

  it("suppresses All Day lock figures to null even when walletSummary has them", () => {
    const r = computeWalletStatRow({
      walletSummary: fullSummary,
      walletTotalFmv: null,
      totals: zeroTotals,
      paginatedTotal: 3,
      collectionSlug: "nfl-all-day",
    })
    expect(r.lockedFmv).toBeNull()
    expect(r.lockedCount).toBeNull()
    // non-lock fields unaffected
    expect(r.walletFmv).toBe(1000)
    expect(r.unlockedFmv).toBe(600)
  })

  it("nulls bestOfferTotal and spreadGap when there is no offer total", () => {
    const r = computeWalletStatRow({
      walletSummary: fullSummary,
      walletTotalFmv: null,
      totals: { ...zeroTotals, totalBestOffer: 0 },
      paginatedTotal: 1,
      collectionSlug: "nba-top-shot",
    })
    expect(r.bestOfferTotal).toBeNull()
    expect(r.spreadGap).toBeNull()
  })

  it("prefers paginatedTotal then totalCount then null for momentCount", () => {
    expect(
      computeWalletStatRow({ walletSummary: null, walletTotalFmv: null, totals: { ...zeroTotals, totalCount: 9 }, paginatedTotal: 4, collectionSlug: "x" }).momentCount,
    ).toBe(4)
    expect(
      computeWalletStatRow({ walletSummary: null, walletTotalFmv: null, totals: { ...zeroTotals, totalCount: 9 }, paginatedTotal: 0, collectionSlug: "x" }).momentCount,
    ).toBe(9)
    expect(
      computeWalletStatRow({ walletSummary: null, walletTotalFmv: null, totals: zeroTotals, paginatedTotal: 0, collectionSlug: "x" }).momentCount,
    ).toBeNull()
  })
})

describe("computeLoanDefaults", () => {
  it("returns null when there are no loan-defaulted rows", () => {
    const rows: PortfolioMomentRow[] = [
      { acquisitionMethod: "marketplace", loanPrincipal: 50 },
      { acquisitionMethod: "pack_pull" },
    ]
    expect(computeLoanDefaults(rows)).toBeNull()
    expect(computeLoanDefaults([])).toBeNull()
  })

  it("sums loanPrincipal when present and positive", () => {
    const rows: PortfolioMomentRow[] = [
      { acquisitionMethod: "loan_default", loanPrincipal: 100 },
      { acquisitionMethod: "loan_default", loanPrincipal: 50 },
    ]
    expect(computeLoanDefaults(rows)).toEqual({ count: 2, totalPrincipal: 150 })
  })

  it("falls back to costBasis when principal is missing/non-positive, else 0", () => {
    const rows: PortfolioMomentRow[] = [
      { acquisitionMethod: "loan_default", loanPrincipal: 0, costBasis: 40 }, // principal 0 → costBasis
      { acquisitionMethod: "loan_default", costBasis: 60 }, // no principal → costBasis
      { acquisitionMethod: "loan_default" }, // neither → 0
      { acquisitionMethod: "loan_default", loanPrincipal: -5, costBasis: -9 }, // both non-positive → 0
    ]
    expect(computeLoanDefaults(rows)).toEqual({ count: 4, totalPrincipal: 100 })
  })

  it("ignores non-loan rows in both count and total", () => {
    const rows: PortfolioMomentRow[] = [
      { acquisitionMethod: "loan_default", loanPrincipal: 30 },
      { acquisitionMethod: "gift", loanPrincipal: 999 },
    ]
    expect(computeLoanDefaults(rows)).toEqual({ count: 1, totalPrincipal: 30 })
  })
})

describe("computeCostBasisSummary", () => {
  const emptyMap = new Map<string, { buyPrice: number }>()

  it("uses authoritative wallet-wide totals and counts rows with cost data", () => {
    const rows: PortfolioMomentRow[] = [
      { flowId: "a", costBasis: 10 },
      { flowId: "b", costBasis: 0 }, // no cost → not counted
      { flowId: "c" }, // no cost → not counted
    ]
    const map = new Map([["a", { buyPrice: 25 }]])
    const s = computeCostBasisSummary(fullSummary, rows, map)
    expect(s).not.toBeNull()
    expect(s!.walletWide).toBe(true)
    expect(s!.totalCost).toBe(500)
    expect(s!.totalFmv).toBe(1000)
    expect(s!.totalPl).toBe(500)
    expect(s!.plPct).toBe(100)
    expect(s!.count).toBe(1) // only flowId "a" has a positive basis
  })

  it("sums per-row basis and fmv when no wallet-wide cost basis", () => {
    const rows: PortfolioMomentRow[] = [
      { flowId: "a", costBasis: 40, fmv: 60 }, // counted: pl +20
      { flowId: "b", costBasis: 10, fmv: 0 }, // fmv 0 → skipped
      { flowId: "c", costBasis: 0, fmv: 100 }, // basis 0 → skipped
    ]
    const s = computeCostBasisSummary(null, rows, emptyMap)
    expect(s).not.toBeNull()
    expect(s!.walletWide).toBe(false)
    expect(s!.totalCost).toBe(40)
    expect(s!.totalFmv).toBe(60)
    expect(s!.totalPl).toBe(20)
    expect(s!.plPct).toBe(50)
    expect(s!.count).toBe(1)
  })

  it("prefers the costBasis map buyPrice over the row costBasis", () => {
    const rows: PortfolioMomentRow[] = [{ flowId: "a", costBasis: 40, fmv: 100 }]
    const map = new Map([["a", { buyPrice: 25 }]])
    const s = computeCostBasisSummary(null, rows, map)
    expect(s!.totalCost).toBe(25) // map wins over row's 40
    expect(s!.totalPl).toBe(75)
  })

  it("returns null when there is no cost data (totalCost === 0)", () => {
    const rows: PortfolioMomentRow[] = [
      { flowId: "a", costBasis: 0, fmv: 100 },
      { flowId: "b", fmv: 50 },
    ]
    expect(computeCostBasisSummary(null, rows, emptyMap)).toBeNull()
  })

  it("treats a walletSummary with cost_basis <= 0 as the per-row path", () => {
    const zeroCb: NonNullable<WalletSummary> = { ...fullSummary, cost_basis: 0 }
    const rows: PortfolioMomentRow[] = [{ flowId: "a", costBasis: 30, fmv: 45 }]
    const s = computeCostBasisSummary(zeroCb, rows, emptyMap)
    expect(s!.walletWide).toBe(false)
    expect(s!.totalCost).toBe(30)
    expect(s!.totalFmv).toBe(45)
  })

  it("reports a negative P&L and percentage", () => {
    const rows: PortfolioMomentRow[] = [{ flowId: "a", costBasis: 100, fmv: 60 }]
    const s = computeCostBasisSummary(null, rows, emptyMap)
    expect(s!.totalPl).toBe(-40)
    expect(s!.plPct).toBe(-40)
  })
})

// 2026-09-06: the Collection tab was the last surface headlining the RAW sum
// ($87,812) while the dashboard/profile/share card for the same wallet said
// $50,234 + $44,039 stale. One basis everywhere: total − stale, stale disclosed.
describe("computeWalletStatRow — headline is total − stale when the summary carries the split", () => {
  const totals = { totalFmv: 0, totalCount: 0, unlockedFmv: 0, unlockedCount: 0, lockedFmv: 0, lockedCount: 0, totalBestOffer: 0 } as any
  it("subtracts stale_fmv from wallet_fmv and exposes the split", () => {
    const r = computeWalletStatRow({
      walletSummary: { wallet_fmv: 87726.65, stale_fmv: 41200, stale_count: 93, unlocked_fmv: 1, unlocked_count: 1, locked_fmv: 1, locked_count: 1, cost_basis: 0, current_fmv: 0, pnl: 0 },
      walletTotalFmv: null, totals, paginatedTotal: 15290, collectionSlug: "nba-top-shot",
    })
    expect(r.walletFmv).toBeCloseTo(46526.65, 2)
    expect(r.staleFmv).toBe(41200)
    expect(r.staleCount).toBe(93)
  })
  it("an older summary without the split renders the total unchanged (no NaN, stale 0)", () => {
    const r = computeWalletStatRow({
      walletSummary: { wallet_fmv: 500, unlocked_fmv: 1, unlocked_count: 1, locked_fmv: 1, locked_count: 1, cost_basis: 0, current_fmv: 0, pnl: 0 },
      walletTotalFmv: null, totals, paginatedTotal: 3, collectionSlug: "nba-top-shot",
    })
    expect(r.walletFmv).toBe(500)
    expect(r.staleFmv).toBe(0)
    expect(r.staleUnknown).toBe(false) // a summary arrived — the split is known (and zero)
  })
  it("with NO summary the raw-total fallback is FLAGGED as unknown-stale, so the tile can say so", () => {
    const r = computeWalletStatRow({
      walletSummary: null, walletTotalFmv: 87786.31, totals, paginatedTotal: 15290, collectionSlug: "nba-top-shot",
    })
    expect(r.walletFmv).toBe(87786.31)
    expect(r.staleUnknown).toBe(true)
  })
  it("with NO summary and NO server total, a PARTIAL row sum is NOT published as the wallet FMV", () => {
    const partial = { totalFmv: 1234.5, totalCount: 50, unlockedFmv: 0, unlockedCount: 0, lockedFmv: 0, lockedCount: 0, totalBestOffer: 0 } as any
    const r = computeWalletStatRow({ walletSummary: null, walletTotalFmv: null, totals: partial, paginatedTotal: 15290, collectionSlug: "nba-top-shot" })
    expect(r.walletFmv).toBeNull()
    // …but a COMPLETE row set may stand in (every row loaded).
    const complete = computeWalletStatRow({ walletSummary: null, walletTotalFmv: null, totals: { ...partial, totalCount: 50 }, paginatedTotal: 50, collectionSlug: "nba-top-shot" })
    expect(complete.walletFmv).toBe(1234.5)
    expect(complete.staleUnknown).toBe(true)
  })
  it("with NO summary and NO total there is nothing to flag (the tile renders an em-dash)", () => {
    const r = computeWalletStatRow({ walletSummary: null, walletTotalFmv: null, totals, paginatedTotal: 0, collectionSlug: "nba-top-shot" })
    expect(r.walletFmv).toBeNull()
    expect(r.staleUnknown).toBe(false)
  })
})

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import PortfolioSummary from "@/components/collection/PortfolioSummary"
import type { MomentRow } from "@/lib/collection/types"

afterEach(cleanup)

// Pins the wallet portfolio summary's display adapter + the financially-sensitive
// branches: the All Day lock-suppression (stale locks must render em-dash, not a
// months-old count as fact — the 2026-07-19 fix), the P&L sign/percent, and the
// loan-default callout.

const totals = {
  totalFmv: 5000,
  totalBestOffer: 4200,
  lockedFmv: 1200,
  unlockedFmv: 3800,
  totalCount: 40,
  lockedCount: 8,
  unlockedCount: 32,
  spreadGap: 800,
  badgeCount: 5,
  confHigh: 10,
  confMedium: 5,
  confLow: 2,
  confNone: 1,
}

const base = {
  hasSearched: true,
  walletSummary: null,
  walletTotalFmv: 5000 as number | null,
  totals,
  paginatedTotal: 40,
  walletSummaryLoading: false,
  acquisitionStats: null,
  rows: [] as MomentRow[],
  costBasis: new Map(),
  nearCompleteSets: [] as unknown[],
  collectionSlug: "nba-top-shot",
  connectedWallet: "0xabc",
  ownerKey: "owner",
  input: "0xabc",
}

describe("PortfolioSummary", () => {
  it("renders nothing until a wallet has been searched", () => {
    const { container } = render(<PortfolioSummary {...base} hasSearched={false} />)
    expect(container.textContent).toBe("")
  })

  it("renders the wallet stat tiles once searched (client-computed fallback)", () => {
    const { container } = render(<PortfolioSummary {...base} />)
    const txt = container.textContent!
    expect(txt).toContain("Wallet FMV")
    expect(txt).toContain("Locked FMV")
    expect(txt).toContain("8 locked")
  })

  it("SUPPRESSES All Day locks — renders em-dash, never a stale locked count", () => {
    const { container } = render(<PortfolioSummary {...base} collectionSlug="nfl-all-day" />)
    const txt = container.textContent!
    // lockUntracked → lockedCount null → "n/a for this collection", never "8 locked"
    expect(txt).not.toContain("8 locked")
    expect(txt).toContain("n/a for this collection")
  })

  it("shows acquisition-source tiles when there are acquisitions", () => {
    const { container } = render(
      <PortfolioSummary
        {...base}
        acquisitionStats={{
          pack_pull_count: 12,
          marketplace_count: 20,
          challenge_reward_count: 8,
          gift_count: 0,
          total_count: 40,
          locked_count: 8,
          total_spent: 999,
        }}
      />,
    )
    const txt = container.textContent!
    expect(txt).toContain("From Packs")
    expect(txt).toContain("From Market")
    expect(txt).toContain("Rewards")
  })

  it("renders a positive P&L with a + sign and percent from walletSummary", () => {
    const { container } = render(
      <PortfolioSummary
        {...base}
        walletSummary={{
          wallet_fmv: 5000,
          unlocked_fmv: 3800,
          unlocked_count: 32,
          locked_fmv: 1200,
          locked_count: 8,
          cost_basis: 4000,
          current_fmv: 5000,
          pnl: 1000,
        }}
      />,
    )
    const txt = container.textContent!
    expect(txt).toContain("Cost Basis:")
    expect(txt).toContain("+1000.00")
    expect(txt).toContain("+25%") // 1000 / 4000
    expect(txt).toContain("wallet-wide totals")
  })

  it("renders the loan-default callout summing principal", () => {
    const rows = [
      { flowId: "1", acquisitionMethod: "loan_default", loanPrincipal: 100, costBasis: 0, fmv: 150 },
      { flowId: "2", acquisitionMethod: "loan_default", loanPrincipal: 0, costBasis: 50, fmv: 60 },
      { flowId: "3", acquisitionMethod: "marketplace", loanPrincipal: 0, costBasis: 10, fmv: 20 },
    ] as unknown as MomentRow[]
    const { container } = render(<PortfolioSummary {...base} rows={rows} />)
    const txt = container.textContent!
    expect(txt).toContain("2 acquired via loan default")
    expect(txt).toContain("$150.00 principal") // 100 + 50
  })
})

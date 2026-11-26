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
    // 2026-11-24: one Collection value + plain stats (was four captioned tiles).
    expect(txt).toContain("Collection value")
    expect(txt).toContain("$5,000")
    expect(txt).toContain("Unlocked$3,800")
  })

  // ⛔ INVERTED 2026-09-13, NOT DELETED. This assertion is what held the All Day
  // suppression in place, on the premise that its is_locked flags were "frozen at
  // a past manual run". Re-derived against the live table: All Day is 99.6%
  // checked within 7 days, nothing older than 3 days, allday-lock-refresh writing
  // 326,787 rows a day — the freshest lock data of any collection. The suppression
  // hid 140,084 genuinely locked moments behind "n/a for this collection", which
  // is the mirror of a fabricated value: an `unknown` that is actually KNOWN.
  it("⛔ RENDERS All Day locks — the suppression premise was re-derived and is false", () => {
    const { container } = render(<PortfolioSummary {...base} collectionSlug="nfl-all-day" />)
    const txt = container.textContent!
    expect(txt).toContain("Unlocked$3,800")
    expect(txt).not.toContain("n/a for this collection")
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
    // 2026-11-24: one source bar in the hero, not three tiles.
    expect(txt).toContain("Packs 12")
    expect(txt).toContain("Market 20")
    expect(txt).toContain("Rewards 8")
    expect(txt).not.toContain("From Packs")
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
    // 2026-11-24: the cost-basis strip folds into one Profit / Loss stat, no caption.
    expect(txt).toContain("Profit / Loss+$1,000 (+25%)") // 1000 / 4000
    expect(txt).not.toContain("Cost Basis:")
    expect(txt).not.toContain("moments with a known cost")
  })

  it("suppresses the wallet totals and cost-basis/P&L block for a closed market", () => {
    // UFC Strike's market is closed — the wallet view must show a count + note
    // (via WalletStatRow) and must NOT render a "Current FMV"/P&L figure that
    // asserts a live valuation.
    const { container } = render(
      <PortfolioSummary
        {...base}
        collectionSlug="ufc"
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
    // Re-pinned 2026-11-26: UFC's holdings are ONE value across Flow and Aptos ("Your Holdings"),
    // with no migration messaging. The UFC tile carries no P&L line.
    expect(txt).toContain("Your Holdings · current FMV")
    expect(txt).not.toMatch(/migrate/i)
    expect(txt).not.toContain("Profit / Loss") // P&L suppressed
    expect(txt).not.toContain("Collection value")  // the live-market hero is not shown
  })

  // 2026-11-14 (Trevor): the callout is retired — it counted only the LOADED rows ("1 acquired via
  // loan default" on a wallet holding 12) and the principal already enters Cost Basis as buy_price.
  it("renders NO loan-default callout (retired 2026-11-14)", () => {
    const rows = [
      { flowId: "1", acquisitionMethod: "loan_default", loanPrincipal: 100, costBasis: 0, fmv: 150 },
      { flowId: "2", acquisitionMethod: "loan_default", loanPrincipal: 0, costBasis: 50, fmv: 60 },
      { flowId: "3", acquisitionMethod: "marketplace", loanPrincipal: 0, costBasis: 10, fmv: 20 },
    ] as unknown as MomentRow[]
    const { container } = render(<PortfolioSummary {...base} rows={rows} />)
    const txt = container.textContent!
    expect(txt).not.toContain("acquired via loan default")
    expect(txt).not.toContain("principal)")
  })

  // 2026-11-24: a P&L summed over the LOADED rows needed a "not the whole wallet" caveat to be
  // honest; with captions gone it is not shown at all until the wallet-wide summary arrives.
  it("shows no Profit / Loss from a page's rows — only the wallet-wide summary's", () => {
    const rows = [
      { flowId: "1", acquisitionMethod: "marketplace", loanPrincipal: 0, costBasis: 100, fmv: 40 },
      { flowId: "2", acquisitionMethod: "marketplace", loanPrincipal: 0, costBasis: 50, fmv: 30 },
    ] as unknown as MomentRow[]
    for (const total of [40, 2]) {
      const r = render(<PortfolioSummary {...base} walletSummary={null} rows={rows} paginatedTotal={total} />)
      expect(r.container.textContent).toContain("Collection value")
      expect(r.container.textContent).not.toContain("Profit / Loss")
      expect(r.container.textContent).not.toContain("Cost Basis:")
      r.unmount()
    }
  })

  it("a negative wallet-wide P&L renders signed and red", () => {
    const ws = { wallet_fmv: 37874.69, unlocked_fmv: 1435.28, unlocked_count: 35, locked_fmv: 36439.41, locked_count: 15841, cost_basis: 119815.96, current_fmv: 37874.69, pnl: -81941.27 }
    const { getByTestId } = render(<PortfolioSummary {...base} walletSummary={ws} />)
    expect(getByTestId("binder-stat-pnl").textContent).toBe("Profit / Loss-$81,941 (-68%)")
  })

  it("renders the Close-to-Completing callout with and without a missing-cost figure", () => {
    const nearCompleteSets = [
      { setId: "s1", setName: "Base Set", missingCount: 3, totalMissingCost: 42.5 },
      { setId: "s2", setName: "Rare Set", missingCount: 1, totalMissingCost: null },
      // 2026-09-24: partially priced → a lower bound, never a summed-over-zeros figure
      { setId: "s3", setName: "Half Set", missingCount: 2, totalMissingCost: 10, unpricedMissingCount: 1 },
    ]
    const { container } = render(<PortfolioSummary {...base} nearCompleteSets={nearCompleteSets} />)
    const txt = container.textContent!
    expect(txt).toContain("CLOSE TO COMPLETING")
    expect(txt).toContain("Base Set")
    expect(txt).toContain("3 away")
    expect(txt).toContain("$42.50") // totalMissingCost present
    expect(txt).toContain("Rare Set")
    expect(txt).toContain("1 away · unpriced") // unknown cost is named, never "$0.00"
    expect(txt).not.toContain("$0.00")
    expect(txt).toContain("2 away · ≥ $10.00 (1 unpriced)")
    expect(txt).toContain("·") // multi-set join separator
  })

  it("All Day's callout links All Day's Sets tab and states no dollar figure (its figure is an FMV sum) — 2026-10-26", () => {
    const nearCompleteSets = [{ setId: "s1", setName: "Gridiron", missingCount: 1, totalMissingCost: 12 }]
    const { container } = render(<PortfolioSummary {...base} collectionSlug="nfl-all-day" nearCompleteSets={nearCompleteSets} />)
    expect(container.textContent).toContain("Gridiron — 1 away")
    expect(container.textContent).not.toContain("$12.00")
    expect(container.querySelector('a[href="/nfl-all-day/sets"]')).not.toBeNull()
    expect(container.querySelector('a[href="/nba-top-shot/sets"]')).toBeNull()
  })

  it("does NOT render the Close-to-Completing callout before a search", () => {
    const nearCompleteSets = [{ setId: "s1", setName: "Base Set", missingCount: 3, totalMissingCost: 10 }]
    const { container } = render(
      <PortfolioSummary {...base} hasSearched={false} nearCompleteSets={nearCompleteSets} />,
    )
    expect(container.textContent).toBe("")
  })
})

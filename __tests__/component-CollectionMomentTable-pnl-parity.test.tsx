// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// P&L PARITY between the two render trees, and the cost-basis chips that
// suppress P&L entirely.
//
// ⚠ FOUND BY WRITING THIS. The mobile card computed its P&L basis as
//
//     const basis = label === "Loan" ? cb.buyPrice : cb.buyPrice
//
// a ternary whose branches are IDENTICAL — i.e. `cb.buyPrice` unconditionally.
// The desktop P&L column derives the same number through the shared, named
// resolveMomentPnlBasis(), whose rule is deliberately narrower: only a
// "Bought"/"Loan" cost-basis amount is trusted as a purchase price, and
// anything else falls back to lastPurchasePrice. So a row carrying a cost-basis
// AMOUNT with NO LABEL — exactly what the component's own `cb` fallback builds
// from row.costBasis when row.costBasisLabel is null — produced ONE P&L on a
// phone and a DIFFERENT one on a desktop, for the same moment. The helper was
// written for the desktop column and never applied to the mobile tree.
//
// Same family as the mobile empty state fixed earlier: this file renders two
// separate trees, and the second one drifts because it is maintained by hand.
//
// The chips are the other half. PACK / GIFT / REWARD / AIRDROP each return
// BEFORE any P&L is computed, and that is correct — a pulled, gifted or
// airdropped moment has no purchase price, so a "profit" against $0 would be
// pure invention. A test that only checked the happy path would let a refactor
// start reporting 100% gains on every pack pull.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(() => cleanup())

function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m1",
    flowId: "f1",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "RARE",
    editionKey: "73:2785",
    serialNumber: 5,
    mintCount: 1000,
    fmv: 200,
    fmvConfidence: "HIGH",
    badgeInfo: null,
    parallel: null,
    subedition: null,
    editionsOwned: 1,
    editionsLocked: 0,
    lowAsk: null,
    lastPurchasePrice: null,
    costBasis: null,
    costBasisLabel: null,
    ...over,
  }
}

const props = (over: Record<string, any> = {}) => ({
  isMobile: false,
  filteredRows: [row()],
  rowsCount: 1,
  summary: { totalMoments: 1 } as any,
  view: { expandedRows: {}, sortKey: "player", sortDir: "asc" } as any,
  toggleExpanded: vi.fn(),
  batchEditionStats: new Map(),
  costBasis: new Map(),
  collectionSeriesMap: new Map(),
  collectionSlug: "nba-top-shot",
  badgeCollectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  connectedWallet: null,
  ownerKey: "0xabc",
  input: "0xabc",
  hasSearched: true,
  loading: false,
  showDebug: false,
  getPackCount: () => 0,
  accent: "#E03A2F",
  ...over,
})

/** Render the same row on both layouts and return each tree's text. */
function bothLayouts(r: Record<string, any>) {
  const desktop = render(<CollectionMomentTable {...props({ isMobile: false, filteredRows: [r] })} />)
  const desktopText = desktop.container.textContent ?? ""
  desktop.unmount()
  const mobile = render(<CollectionMomentTable {...props({ isMobile: true, filteredRows: [r] })} />)
  const mobileText = mobile.container.textContent ?? ""
  mobile.unmount()
  return { desktopText, mobileText }
}

describe("the two layouts agree on the P&L basis", () => {
  it("an UNLABELLED cost-basis amount is not trusted as a purchase price on either", () => {
    // The regression case. costBasis 50 with no label, and no lastPurchasePrice:
    // the canonical rule yields NO basis, so neither tree may report a P&L.
    // Before the fix the mobile card reported +$150 (+300%) off the 50.
    const { desktopText, mobileText } = bothLayouts(
      row({ costBasis: 50, costBasisLabel: null, fmv: 200 })
    )
    expect(mobileText).not.toMatch(/\+150\.00|\+300%/)
    expect(desktopText).not.toMatch(/\+150\.00|\+300%/)
  })

  it("falls back to lastPurchasePrice identically on both", () => {
    // Same rule, other direction: an unlabelled amount is ignored and the last
    // purchase price is used, so BOTH trees must report the same +$100 (+100%).
    const { desktopText, mobileText } = bothLayouts(
      row({ costBasis: 50, costBasisLabel: null, lastPurchasePrice: 100, fmv: 200 })
    )
    expect(mobileText).toMatch(/\+100\.00/)
    expect(desktopText).toMatch(/\+100\.00/)
  })

  it('reports the same P&L for a "Bought" moment on both', () => {
    const { desktopText, mobileText } = bothLayouts(
      row({ costBasis: 100, costBasisLabel: "Bought", fmv: 250 })
    )
    expect(mobileText).toMatch(/\+150\.00/)
    expect(desktopText).toMatch(/\+150\.00/)
  })

  it('reports the same P&L for a "Loan" default on both', () => {
    // Loan IS a trusted basis per resolveMomentPnlBasis — the principal lent
    // against the moment. The mobile card additionally labels it "Loan Default"
    // so the number is not mistaken for a purchase.
    const { desktopText, mobileText } = bothLayouts(
      row({ costBasis: 80, costBasisLabel: "Loan", fmv: 40 })
    )
    expect(mobileText).toMatch(/-40\.00/)
    expect(desktopText).toMatch(/-40\.00/)
    expect(mobileText).toContain("Loan Default")
  })
})

describe("acquisition chips suppress P&L rather than inventing a gain", () => {
  for (const [label, chip] of [
    ["Pack", "PACK"],
    ["Gift", "GIFT"],
    ["Reward", "REWARD"],
    ["Airdrop", "AIRDROP"],
  ] as const) {
    it(`renders the ${chip} chip and NO profit for a ${label} acquisition`, () => {
      // These have no purchase price. Reporting "+$200 (+∞%)" against a $0
      // basis would be a fabricated gain on every pack pull a collector owns.
      const { container } = render(
        <CollectionMomentTable
          {...props({
            isMobile: true,
            filteredRows: [row({ costBasis: 0, costBasisLabel: label, fmv: 200 })],
          })}
        />
      )
      const t = container.textContent ?? ""
      expect(t).toContain(chip)
      expect(t).not.toMatch(/\+200\.00|\+\d+%|Infinity|NaN/)
    })
  }

  it("reports no P&L when the moment has no FMV to compare against", () => {
    // A basis without a current value is not a loss — it is unknown.
    const { container } = render(
      <CollectionMomentTable
        {...props({
          isMobile: true,
          filteredRows: [row({ costBasis: 100, costBasisLabel: "Bought", fmv: null })],
        })}
      />
    )
    expect(container.textContent).not.toMatch(/-100\.00|\+0\.00/)
  })

  it("never emits NaN or Infinity from a zero basis", () => {
    const { container } = render(
      <CollectionMomentTable
        {...props({
          isMobile: true,
          filteredRows: [row({ costBasis: 0, costBasisLabel: "Bought", fmv: 200 })],
        })}
      />
    )
    expect(container.textContent).not.toMatch(/NaN|Infinity/)
  })
})

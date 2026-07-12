// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// next/link is not needed for logic here — stub it to a plain anchor so the
// component (via FmvDisclaimer) renders in jsdom without the Next runtime.
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

import WalletStatRow, { WalletStatRowProps } from "@/components/wallet-stat-row"

afterEach(cleanup)

function props(overrides: Partial<WalletStatRowProps> = {}): WalletStatRowProps {
  return {
    walletFmv: 1000,
    unlockedFmv: 600,
    lockedFmv: 400,
    bestOfferTotal: 800,
    momentCount: 12,
    unlockedCount: 8,
    lockedCount: 4,
    spreadGap: 200,
    collectionSlug: "nba-top-shot",
    ...overrides,
  }
}

describe("WalletStatRow", () => {
  it("renders formatted currency for each tile and the moment count caption", () => {
    const { container } = render(<WalletStatRow {...props()} />)
    const txt = container.textContent!
    expect(txt).toContain("$1,000")
    expect(txt).toContain("$600")
    expect(txt).toContain("$400")
    expect(txt).toContain("$800")
    expect(txt).toContain("12 moments")
    expect(txt).toContain("8 unlocked")
    expect(txt).toContain("4 locked")
  })

  it("uses 'pins' as the unit noun for Disney Pinnacle", () => {
    const { container } = render(<WalletStatRow {...props({ collectionSlug: "disney-pinnacle" })} />)
    expect(container.textContent).toContain("12 pins")
  })

  it("shows an em-dash for null FMV (not $0) and 'n/a for this collection' for null locked count", () => {
    const { container } = render(
      <WalletStatRow {...props({ lockedFmv: null, lockedCount: null })} />
    )
    expect(container.textContent).toContain("—")
    expect(container.textContent).toContain("n/a for this collection")
  })

  it("distinguishes a real computed $0 from missing data", () => {
    const { container } = render(<WalletStatRow {...props({ unlockedFmv: 0 })} />)
    expect(container.textContent).toContain("$0")
  })

  it("renders the vs-FMV spread gap only when both sides are positive numbers", () => {
    const shown = render(<WalletStatRow {...props({ walletFmv: 1000, bestOfferTotal: 800, spreadGap: 200 })} />)
    expect(shown.container.textContent).toContain("vs FMV: -$200")
    cleanup()
    // bestOfferTotal 0 → gap suppressed.
    const hidden = render(<WalletStatRow {...props({ bestOfferTotal: 0 })} />)
    expect(hidden.container.textContent).not.toContain("vs FMV:")
  })

  it("swaps the caption for a hydration progress bar when loadProgress is partial", () => {
    const { container } = render(
      <WalletStatRow {...props({ loadProgress: { loaded: 30, total: 120, pct: 25 } })} />
    )
    const txt = container.textContent!
    expect(txt).toContain("30 / 120 moments")
    expect(txt).toContain("25%")
    // The plain "N moments" caption is replaced by the progress UI.
    expect(txt).not.toContain("12 moments")
  })
})

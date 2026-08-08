// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// MomentDetailModal — live on the sniper + collection pages (the audit docs
// wrongly flagged it as dead code). Pins the Moment-V3 a11y contract (dialog
// role, Escape-to-close, backdrop-vs-content click semantics) and the
// Flowty-shutdown CTA rule (a flowty-sourced buyUrl must NOT render a Buy CTA).

import MomentDetailModal from "@/components/MomentDetailModal"

afterEach(cleanup)

function moment(over: Record<string, unknown> = {}) {
  return {
    flowId: "12345",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "RARE",
    serialNumber: 7,
    mintSize: 749,
    fmv: 42.5,
    listingPrice: 30,
    buyUrl: "https://nbatopshot.com/listings/p2p/x",
    ...over,
  }
}

describe("MomentDetailModal — a11y contract (Moment V3)", () => {
  it("renders as an aria-modal dialog and closes on Escape", () => {
    const onClose = vi.fn()
    const { getByRole } = render(<MomentDetailModal moment={moment()} onClose={onClose} />)
    const dialog = getByRole("dialog")
    expect(dialog.getAttribute("aria-modal")).toBe("true")

    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on backdrop click but NOT on clicks inside the dialog content", () => {
    const onClose = vi.fn()
    const { getByRole, getByText } = render(
      <MomentDetailModal moment={moment()} onClose={onClose} />,
    )
    fireEvent.click(getByText("Damian Lillard"))
    expect(onClose).not.toHaveBeenCalled()

    const backdrop = getByRole("dialog").parentElement!
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("the close button is labeled for screen readers and fires onClose", () => {
    const onClose = vi.fn()
    const { getByLabelText } = render(<MomentDetailModal moment={moment()} onClose={onClose} />)
    fireEvent.click(getByLabelText("Close Damian Lillard details"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders nothing when moment is null", () => {
    const { container } = render(<MomentDetailModal moment={null} onClose={() => {}} />)
    expect(container.innerHTML).toBe("")
  })
})

describe("MomentDetailModal — ASK_ONLY 'from asks' honesty marker", () => {
  it("shows the 'from asks' marker for an ask-derived FMV", () => {
    const { getByText } = render(
      <MomentDetailModal moment={moment({ marketConfidence: "ask_only" })} onClose={() => {}} />,
    )
    expect(getByText("from asks")).toBeTruthy()
  })

  it("does NOT show the marker for a sale-derived FMV (and never the confidence enum)", () => {
    const { queryByText } = render(
      <MomentDetailModal moment={moment({ marketConfidence: "high" })} onClose={() => {}} />,
    )
    expect(queryByText("from asks")).toBeNull()
    // The internal confidence vocabulary must never reach the DOM.
    expect(queryByText(/high/i)).toBeNull()
  })
})

describe("MomentDetailModal — marketplace CTA rules", () => {
  it("shows the buy link for a topshot-sourced listing", () => {
    const { container } = render(
      <MomentDetailModal moment={moment()} marketplaceSource="topshot" onClose={() => {}} />,
    )
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("https://nbatopshot.com/listings/p2p/x")
  })

  it("hides the buy CTA for a flowty-sourced listing (marketplace shut down May 2026)", () => {
    const { container } = render(
      <MomentDetailModal moment={moment()} marketplaceSource="flowty" onClose={() => {}} />,
    )
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).not.toContain("https://nbatopshot.com/listings/p2p/x")
  })

  it("renders the dapper.market secondary link when dapperUrl is provided", () => {
    const { container } = render(
      <MomentDetailModal moment={moment()} dapperUrl="https://dapper.market/x" onClose={() => {}} />,
    )
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("https://dapper.market/x")
  })
})

describe("MomentDetailModal — financial cells + provenance branches", () => {
  it("renders serial/mint, listing, best offer, and badges", () => {
    const { container } = render(
      <MomentDetailModal
        moment={moment({
          bestOffer: 300,
          badgeTitles: ["Rookie Year"],
          officialBadges: ["Championship"],
        })}
        onClose={() => {}}
      />,
    )
    const text = container.textContent ?? ""
    expect(text).toContain("#7") // serialNumber
    expect(text).toContain("749") // mintSize
    expect(text).toContain("$300.00") // bestOffer > 0
    expect(text).toContain("Rookie Year")
    expect(text).toContain("Championship")
  })

  it("omits the best-offer cell when the offer is zero (never shows $0.00)", () => {
    const { container } = render(
      <MomentDetailModal moment={moment({ bestOffer: 0 })} onClose={() => {}} />,
    )
    expect((container.textContent ?? "")).not.toContain("$0.00")
  })

  it("omits serial/mint/fmv/listing cells when those fields are null", () => {
    const { getByText, container } = render(
      <MomentDetailModal
        moment={moment({ serialNumber: null, mintSize: null, fmv: null, listingPrice: null })}
        onClose={() => {}}
      />,
    )
    expect(getByText("Damian Lillard")).toBeTruthy() // shell still renders
    expect((container.textContent ?? "")).not.toContain("#7")
  })

  it("renders each deal-rating colour band (>=0.7 / >=0.4 / <0.4 / null) without error", () => {
    for (const dealRating of [0.9, 0.55, 0.2, null]) {
      const { getByRole, unmount } = render(
        <MomentDetailModal moment={moment({ dealRating })} onClose={() => {}} />,
      )
      expect(getByRole("dialog")).toBeTruthy()
      unmount()
    }
  })

  it("renders the loan-default provenance block: truncated source wallet + principal", () => {
    const { container } = render(
      <MomentDetailModal
        moment={moment({
          acquisitionMethod: "loan_default",
          sourceAddress: "0xbd94cade097e50ac",
          loanPrincipal: 1200,
        })}
        onClose={() => {}}
      />,
    )
    const text = container.textContent ?? ""
    expect(text).toContain("0xbd94…50ac") // truncateAddress
    expect(text).toContain("$1200.00") // loanPrincipal (USDC 1:1 USD)
    // the wallet links to its analytics page
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("/analytics/wallets/0xbd94cade097e50ac")
  })
})

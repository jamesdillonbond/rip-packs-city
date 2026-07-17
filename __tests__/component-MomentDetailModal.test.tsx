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
})

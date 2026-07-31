// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import PaywallModal from "@/components/PaywallModal"

// The Pro upgrade modal: open/closed gate, the featureName headline, default vs
// custom feature list, the CTA link, and the three dismissal paths (Escape,
// backdrop click, close/secondary buttons) — while an in-card click must NOT
// close (stopPropagation).

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("PaywallModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <PaywallModal open={false} onClose={() => {}} featureName="Insider Signals" />,
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it("renders the feature-named headline + default features when open", () => {
    const { getByRole, getByText } = render(
      <PaywallModal open onClose={() => {}} featureName="Insider Signals" />,
    )
    expect(getByRole("dialog")).toBeTruthy()
    expect(getByText(/Unlock Insider Signals — RPC Pro/)).toBeTruthy()
    // a default feature line
    expect(getByText("Unlimited saved wallets")).toBeTruthy()
  })

  it("uses custom features/labels/upgradeUrl + optional description when provided", () => {
    const { getByText, queryByText } = render(
      <PaywallModal
        open
        onClose={() => {}}
        featureName="Pack EV"
        description="See depletion-adjusted EV"
        features={["Only feature A"]}
        ctaLabel="Go Pro Now"
        upgradeUrl="/pricing?ref=paywall"
      />,
    )
    expect(getByText("See depletion-adjusted EV")).toBeTruthy()
    expect(getByText("Only feature A")).toBeTruthy()
    expect(queryByText("Unlimited saved wallets")).toBeNull()
    const cta = getByText("Go Pro Now")
    expect(cta.getAttribute("href")).toBe("/pricing?ref=paywall")
  })

  it("closes on Escape", () => {
    const onClose = vi.fn()
    render(<PaywallModal open onClose={onClose} featureName="X" />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on backdrop click, close button, and secondary button", () => {
    const onClose = vi.fn()
    const { getByRole, getByLabelText, getByText } = render(
      <PaywallModal open onClose={onClose} featureName="X" secondaryLabel="Maybe later" />,
    )
    fireEvent.click(getByRole("dialog")) // backdrop
    fireEvent.click(getByLabelText("Close upgrade prompt")) // × button
    fireEvent.click(getByText("Maybe later")) // secondary
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it("does NOT close when clicking inside the card", () => {
    const onClose = vi.fn()
    const { getByText } = render(<PaywallModal open onClose={onClose} featureName="X" />)
    fireEvent.click(getByText(/Unlock X/)) // headline is inside the card
    expect(onClose).not.toHaveBeenCalled()
  })
})

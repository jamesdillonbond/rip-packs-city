// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import UpgradePrompt from "@/components/UpgradePrompt"

// UpgradePrompt has two variants. "compact" is a single-line note with a
// default free-plan message and a CTA link. "full" is a card that lists Pro
// features (a default set unless overridden), an optional message, headline,
// and a CTA. Both point the CTA at upgradeUrl (default /pricing).

afterEach(cleanup)

describe("UpgradePrompt", () => {
  it("renders the compact variant with the default message and CTA href", () => {
    const { container } = render(<UpgradePrompt />)
    const note = container.querySelector('[role="note"]')!
    expect(note).not.toBeNull()
    expect(note.textContent).toContain("You've hit a free-plan limit.")
    const link = container.querySelector("a")!
    expect(link.getAttribute("href")).toBe("/pricing")
    expect(link.textContent).toContain("See plans")
  })

  it("overrides message, ctaLabel and upgradeUrl in the compact variant", () => {
    const { container } = render(
      <UpgradePrompt message="Daily cap reached" ctaLabel="Go Pro" upgradeUrl="/upgrade" />
    )
    expect(container.textContent).toContain("Daily cap reached")
    const link = container.querySelector("a")!
    expect(link.getAttribute("href")).toBe("/upgrade")
    expect(link.textContent).toContain("Go Pro")
  })

  it("renders the full-variant card with the default feature list and headline", () => {
    const { container } = render(<UpgradePrompt variant="full" />)
    const region = container.querySelector('[role="region"]')!
    expect(region.getAttribute("aria-label")).toBe("RPC Pro upgrade")
    expect(container.textContent).toContain("Unlock RPC Pro")
    // A couple of the DEFAULT_PRO_FEATURES entries.
    expect(container.textContent).toContain("Unlimited saved wallets")
    expect(container.textContent).toContain("Pack EV with confidence intervals")
    // Six default features → six list items.
    expect(container.querySelectorAll("li").length).toBe(6)
  })

  it("uses a custom feature list and headline when provided in the full variant", () => {
    const { container } = render(
      <UpgradePrompt variant="full" headline="Members only" features={["Alpha", "Beta"]} />
    )
    expect(container.textContent).toContain("Members only")
    const items = Array.from(container.querySelectorAll("li")).map((li) => li.textContent)
    expect(items).toEqual(["Alpha", "Beta"])
    expect(container.textContent).not.toContain("Unlimited saved wallets")
  })
})

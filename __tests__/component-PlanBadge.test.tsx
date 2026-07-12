// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import PlanBadge from "@/components/PlanBadge"

// PlanBadge maps a plan enum to a label + accent style. 'free' renders nothing;
// founding gets the gold accent; admin gets blue; every other Pro tier is red
// with the label "Pro" (except pro_trial → "Pro Trial").

afterEach(cleanup)

describe("PlanBadge", () => {
  it("renders nothing for the free plan (no 'Free' badge)", () => {
    const { container } = render(<PlanBadge plan="free" />)
    expect(container.firstChild).toBeNull()
  })

  it("labels founding as 'Founding' with a gold accent + accessible tier label", () => {
    render(<PlanBadge plan="founding" />)
    const el = screen.getByLabelText("Account tier: Founding")
    expect(el.textContent).toBe("Founding")
    // Gold accent color per the FOUNDING style.
    expect(el.getAttribute("style")).toContain("var(--rpc-gold")
  })

  it.each([
    ["moments_payment", "Pro"],
    ["pro_grandfather", "Pro"],
    ["pro_paid", "Pro"],
    ["pro_trial", "Pro Trial"],
  ] as const)("labels %s as '%s'", (plan, label) => {
    render(<PlanBadge plan={plan} />)
    expect(screen.getByLabelText(`Account tier: ${label}`).textContent).toBe(label)
  })

  it("labels admin as 'Admin' with the blue accent", () => {
    render(<PlanBadge plan="admin" />)
    const el = screen.getByLabelText("Account tier: Admin")
    expect(el.textContent).toBe("Admin")
    // jsdom normalizes the #60A5FA hex to its rgb() form.
    expect(el.getAttribute("style")).toContain("rgb(96, 165, 250)")
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// AnalyticsSidebar's load-bearing logic is isActive(pathname, href): the Overview
// row must be active ONLY on exactly "/analytics", while every other row matches
// its href OR a sub-path (startsWith href + "/"). An off-by-one there (e.g.
// Overview matching every /analytics/* route) silently highlights the wrong tab.

let mockPathname = "/analytics"
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}))

import AnalyticsSidebar from "@/components/analytics/AnalyticsSidebar"

const ACTIVE_CLASS = "text-red-400"

/** The rendered <a> whose visible label matches. */
function link(container: HTMLElement, label: string): HTMLAnchorElement {
  const a = Array.from(container.querySelectorAll("a")).find(
    (el) => el.textContent?.replace(/\s+/g, " ").trim().startsWith(label),
  )
  if (!a) throw new Error(`no link labelled ${label}`)
  return a as HTMLAnchorElement
}

beforeEach(() => {
  mockPathname = "/analytics"
})
afterEach(() => cleanup())

describe("AnalyticsSidebar — isActive nav highlighting", () => {
  it("activates Overview ONLY on the exact /analytics path", () => {
    mockPathname = "/analytics"
    const { container } = render(<AnalyticsSidebar />)
    expect(link(container, "Overview").className).toContain(ACTIVE_CLASS)
    expect(link(container, "Sales").className).not.toContain(ACTIVE_CLASS)
  })

  it("does NOT keep Overview active on a sub-route (the off-by-one guard)", () => {
    mockPathname = "/analytics/sales"
    const { container } = render(<AnalyticsSidebar />)
    expect(link(container, "Overview").className).not.toContain(ACTIVE_CLASS)
    expect(link(container, "Sales").className).toContain(ACTIVE_CLASS)
  })

  it("matches a nested sub-path via startsWith (wallets/<addr>)", () => {
    mockPathname = "/analytics/wallets/0xabc123"
    const { container } = render(<AnalyticsSidebar />)
    expect(link(container, "Wallets").className).toContain(ACTIVE_CLASS)
  })

  it("renders the Flowty badge on the Loans row and the Resources group", () => {
    const { container, getByText } = render(<AnalyticsSidebar />)
    expect(link(container, "Loans").textContent).toContain("Flowty")
    expect(getByText("Resources")).toBeTruthy()
    expect(link(container, "Methodology")).toBeTruthy()
    expect(link(container, "Public API")).toBeTruthy()
  })
})

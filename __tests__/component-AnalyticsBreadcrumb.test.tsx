// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

let mockPath: string | null = "/analytics"

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}))
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
}))

import AnalyticsBreadcrumb from "@/components/analytics/AnalyticsBreadcrumb"

afterEach(cleanup)

describe("AnalyticsBreadcrumb", () => {
  it("builds cumulative crumbs from the path with a leading Home link", () => {
    mockPath = "/analytics/loans"
    const { container } = render(<AnalyticsBreadcrumb />)
    const anchors = Array.from(container.querySelectorAll("a"))
    const hrefs = anchors.map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/")
    expect(hrefs).toContain("/analytics")
    const txt = container.textContent!
    expect(txt).toContain("Home")
    expect(txt).toContain("Analytics")
    expect(txt).toContain("Loans")
  })

  it("renders the last crumb as plain text, not a link", () => {
    mockPath = "/analytics/loans"
    const { container } = render(<AnalyticsBreadcrumb />)
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    // "Loans" is the terminal segment -> no /analytics/loans anchor.
    expect(hrefs).not.toContain("/analytics/loans")
    expect(container.textContent).toContain("Loans")
  })

  it("maps known slugs to friendly labels and prettifies unknown slugs", () => {
    mockPath = "/analytics/fmv/cosmic-labs"
    const { container } = render(<AnalyticsBreadcrumb />)
    const txt = container.textContent!
    // LABELS["fmv"] === "FMV Index"
    expect(txt).toContain("FMV Index")
    // pretty("cosmic-labs") -> "Cosmic labs" (capitalize + dashes to spaces)
    expect(txt).toContain("Cosmic labs")
  })

  it("defaults to /analytics when usePathname returns null", () => {
    mockPath = null
    const { container } = render(<AnalyticsBreadcrumb />)
    expect(container.textContent).toContain("Analytics")
    expect(container.textContent).toContain("Home")
  })
})

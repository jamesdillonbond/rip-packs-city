// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import PriceBand30dBadge from "@/components/PriceBand30dBadge"

// PriceBand30dBadge renders a cleaned 10th–90th-percentile range. It renders
// nothing without finite low/high, formats values >= $100 as rounded whole
// dollars and < $100 with two decimals, and pluralizes the sale count in the
// title tooltip.

afterEach(cleanup)

describe("PriceBand30dBadge", () => {
  it("renders nothing for null/invalid data", () => {
    expect(render(<PriceBand30dBadge data={null} />).container.firstChild).toBeNull()
    cleanup()
    expect(render(<PriceBand30dBadge data={{ low: NaN, high: 5, n: 3 }} />).container.firstChild).toBeNull()
  })

  it("formats a >=$100 range as rounded whole dollars with thousands separators", () => {
    const { container } = render(<PriceBand30dBadge data={{ low: 74.4, high: 1299.6, n: 12 }} />)
    expect(container.textContent).toContain("$74")
    expect(container.textContent).toContain("$1,300")
    expect(container.textContent).toContain("30d")
  })

  it("formats a sub-$100 low with two decimals", () => {
    const { container } = render(<PriceBand30dBadge data={{ low: 4.5, high: 130, n: 1 }} />)
    expect(container.textContent).toContain("$4.50")
    expect(container.textContent).toContain("$130")
  })

  it("uses singular 'sale' when n === 1 and plural otherwise", () => {
    const one = render(<PriceBand30dBadge data={{ low: 10, high: 20, n: 1 }} />)
    expect(one.container.querySelector("span")!.getAttribute("title")).toContain("1 sale ")
    cleanup()
    const many = render(<PriceBand30dBadge data={{ low: 10, high: 20, n: 8 }} />)
    expect(many.container.querySelector("span")!.getAttribute("title")).toContain("8 sales ")
  })
})

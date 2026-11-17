// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// ExploreSection — measured at 0% statements before this file. It renders the
// /analytics hub's navigation grid, and its one real branch is the DISABLED
// tile.
//
// That branch matters because of what it swaps: a disabled item renders a plain
// `div`, not a `Link`. Collapsing the two (the natural "simplification") makes
// every not-yet-built tile a live link into a route that does not exist — a
// 404 from the analytics hub, on a surface whose entire job is navigation. The
// "Soon" chip is the user-facing half of the same decision.

import ExploreSection from "@/components/analytics/ExploreSection"

afterEach(cleanup)

const items = [
  { label: "Sales", description: "Recent prints", href: "/analytics/sales", enabled: true },
  { label: "Loans", description: "Loan book", href: "/analytics/loans", enabled: false },
  { label: "Packs", description: "Pack EV", enabled: true }, // enabled but no href
]

describe("ExploreSection", () => {
  it("renders the section title and every item", () => {
    const { container } = render(<ExploreSection title="Explore" items={items} />)
    expect(container.querySelector("h2")?.textContent).toBe("Explore")
    for (const i of items) {
      expect(container.textContent).toContain(i.label)
      expect(container.textContent).toContain(i.description)
    }
  })

  it("links only the enabled items that actually have an href", () => {
    const { container } = render(<ExploreSection title="Explore" items={items} />)
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toEqual(["/analytics/sales"])
  })

  it("renders a disabled item as a non-link, so it cannot navigate anywhere", () => {
    const { container } = render(
      <ExploreSection title="Explore" items={[items[1]]} />,
    )
    expect(container.querySelector("a")).toBeNull()
  })

  it("treats an enabled item with no href as disabled", () => {
    // The subtle half: `enabled: true` alone is not enough — without an href a
    // Link would render with href=undefined and navigate to the current page,
    // which reads as a dead click rather than a coming-soon tile.
    const { container } = render(<ExploreSection title="Explore" items={[items[2]]} />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("Soon")
  })

  it("shows the Soon chip on disabled tiles and not on enabled ones", () => {
    const disabled = render(<ExploreSection title="Explore" items={[items[1]]} />)
    expect(disabled.container.textContent).toContain("Soon")
    cleanup()
    const enabled = render(<ExploreSection title="Explore" items={[items[0]]} />)
    expect(enabled.container.textContent).not.toContain("Soon")
  })

  it("renders an empty grid rather than throwing when there are no items", () => {
    const { container } = render(<ExploreSection title="Explore" items={[]} />)
    expect(container.querySelector("h2")?.textContent).toBe("Explore")
    expect(container.querySelectorAll("a")).toHaveLength(0)
  })
})

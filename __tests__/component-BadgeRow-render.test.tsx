// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// BadgeRow's normalizeBadges helper is unit-tested; its RENDER (priority sort,
// the visible/hidden cap with the "+N" expand toggle, and the null-on-empty
// guard) was uncovered. Mock the taxonomy hook to an empty map (all badges
// unknown → tail, rendered as color-family pills) so the render + sort + cap +
// expand execute deterministically.

vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: () => null,
  classesForColorFamily: () => "bg-zinc-800 text-zinc-200",
}))

import BadgeRow, { type BadgeItem } from "@/components/BadgeRow"

const badges: BadgeItem[] = [
  { id: "b1", title: "Rookie Mint", source: "play" as any },
  { id: "b2", title: "Championship Year" },
  { id: "b3", title: "ALL DAY Debut" },
  { id: "b4", title: "Rookie Year" },
  { id: "b5", title: "MVP" },
]

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
})

afterEach(() => cleanup())

describe("BadgeRow render", () => {
  it("renders up to the cap and a +N overflow chip, then expands to show all", () => {
    const { getByText, getAllByText, queryByText } = render(<BadgeRow badges={badges} maxVisible={3} />)
    // 3 visible + a "+2" overflow (desktop cap = maxVisible = 3).
    expect(getByText("Rookie Mint")).toBeTruthy()
    expect(getByText("+2")).toBeTruthy()
    // The 2 overflow badges aren't shown yet.
    expect(queryByText("MVP")).toBeNull()
    // Expand.
    fireEvent.click(getByText("+2"))
    expect(getAllByText("MVP").length).toBeGreaterThan(0)
  })

  it("renders nothing when there are no badges", () => {
    const { container } = render(<BadgeRow badges={[]} />)
    expect(container.textContent).toBe("")
  })
})

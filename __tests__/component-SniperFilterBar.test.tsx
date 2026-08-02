// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"

vi.mock("@/components/filters/LeagueFilter", () => ({ default: () => null }))

import SniperFilterBar from "@/components/sniper/SniperFilterBar"

// Pins the sniper filter bar's control-to-callback WIRING and its per-collection
// visibility rules. The component holds no state — every input reports through a
// callback prop — so a mis-wired handler silently applies the wrong filter (e.g.
// the max-price box driving discount). It also HIDES controls per collection
// (All Day has no badges / discount / owned-filter; Pinnacle relabels Player →
// Character and hides badges), which is real branching, not decoration.

afterEach(cleanup)

function makeProps(over: Record<string, any> = {}) {
  const cb = {
    onToggleFilters: vi.fn(),
    onPlayerChange: vi.fn(),
    onTierChange: vi.fn(),
    onMinDiscountChange: vi.fn(),
    onMaxPriceChange: vi.fn(),
    onSearchChange: vi.fn(),
    onSerialChange: vi.fn(),
    onSortChange: vi.fn(),
    onBadgeOnlyChange: vi.fn(),
    onVerifiedChange: vi.fn(),
    onOwnedFilterChange: vi.fn(),
    onLeagueChange: vi.fn(),
    onSaveSearch: vi.fn(),
  }
  const props: any = {
    isMobile: false, isPinnacle: false, isAllDay: false, isGolazos: false,
    accent: "#E03A2F", collectionSlug: "nba-top-shot",
    showFilters: true, playerInput: "", tierTab: "all", tabs: ["all", "rare", "legendary"],
    minDiscount: 0, maxPrice: 0, search: "", serialFilter: "all",
    sortBy: "discount", sortOptions: [{ value: "discount", label: "Best Discount" }, { value: "price", label: "Price" }],
    badgeOnly: false, showVerifiedOnly: false, ownedFilter: "all", ownedCount: 0,
    leagueFilter: "all", saveSearchMsg: null,
    ...cb, ...over,
  }
  return { props, cb }
}

describe("SniperFilterBar — wiring (Top Shot desktop)", () => {
  it("routes each control to its own callback", () => {
    const { props, cb } = makeProps()
    render(<SniperFilterBar {...props} />)

    fireEvent.change(screen.getByPlaceholderText("e.g. LeBron"), { target: { value: "Curry" } })
    expect(cb.onPlayerChange).toHaveBeenCalledWith("Curry")

    fireEvent.change(screen.getByPlaceholderText("Search player, set, team…"), { target: { value: "finals" } })
    expect(cb.onSearchChange).toHaveBeenCalledWith("finals")

    fireEvent.click(screen.getByRole("button", { name: "legendary" }))
    expect(cb.onTierChange).toHaveBeenCalledWith("legendary")

    fireEvent.click(screen.getByRole("button", { name: /SAVE SEARCH/i }))
    expect(cb.onSaveSearch).toHaveBeenCalledTimes(1)

    // sort select -> onSortChange with the SortOption value
    fireEvent.change(screen.getByDisplayValue("Best Discount"), { target: { value: "price" } })
    expect(cb.onSortChange).toHaveBeenCalledWith("price")

  })

  // REGRESSION GUARD (2026-08-01). The special-serial select used to live here
  // and was wired to onSerialChange, but it could not be satisfied on any
  // collection: Top Shot is served by the EDITION-level
  // get_topshot_sniper_deals (serial_number NULL on 200/200 rows live), and
  // All Day / Pinnacle / Golazos / UFC never had `serialFilter` passed to their
  // compute functions at all. It was removed rather than left lying to users.
  // If a real per-listing serial source is ever wired up, delete this test and
  // restore the select + its onSerialChange assertion.
  it("does NOT render the special-serial control (unsatisfiable — see route)", () => {
    const { props } = makeProps()
    render(<SniperFilterBar {...props} />)
    expect(screen.queryByDisplayValue("All serials")).toBeNull()
    expect(screen.queryByText("Special only")).toBeNull()
    expect(screen.queryByText("Jersey match")).toBeNull()
  })

  it("min-discount and badges-only are present for Top Shot and wired", () => {
    const { props, cb } = makeProps()
    render(<SniperFilterBar {...props} />)
    expect(screen.getByText("MIN DISC.")).toBeTruthy()
    const badges = screen.getByLabelText(/BADGES ONLY/i) ?? screen.getByText(/BADGES ONLY/i)
    fireEvent.click(badges as Element)
    expect(cb.onBadgeOnlyChange).toHaveBeenCalledWith(true)
  })
})

describe("SniperFilterBar — per-collection visibility", () => {
  it("All Day hides MIN DISC. and BADGES ONLY", () => {
    const { props } = makeProps({ isAllDay: true, collectionSlug: "nfl-all-day" })
    render(<SniperFilterBar {...props} />)
    expect(screen.queryByText("MIN DISC.")).toBeNull()
    expect(screen.queryByText(/BADGES ONLY/i)).toBeNull()
  })

  it("Pinnacle relabels Player -> Character (and placeholder) and hides badges", () => {
    const { props } = makeProps({ isPinnacle: true, collectionSlug: "disney-pinnacle" })
    render(<SniperFilterBar {...props} />)
    expect(screen.getByText("CHARACTER")).toBeTruthy()
    expect(screen.getByPlaceholderText("e.g. Grogu")).toBeTruthy()
    expect(screen.queryByText(/BADGES ONLY/i)).toBeNull()
  })

  it("shows the owned-filter select only when ownedCount>0 and not All Day", () => {
    const { props, cb } = makeProps({ ownedCount: 12 })
    render(<SniperFilterBar {...props} />)
    const owned = screen.getByDisplayValue("ALL")
    fireEvent.change(owned, { target: { value: "owned" } })
    expect(cb.onOwnedFilterChange).toHaveBeenCalledWith("owned")
  })
})

describe("SniperFilterBar — mobile", () => {
  it("collapses the primary filter row until showFilters, and the gear shows the active-filter count", () => {
    const { props } = makeProps({ isMobile: true, showFilters: false, minDiscount: 10, search: "x", maxPrice: 5 })
    render(<SniperFilterBar {...props} />)
    // primary row hidden -> no player input
    expect(screen.queryByPlaceholderText("e.g. LeBron")).toBeNull()
    // gear button shows the count of active filters (minDiscount, maxPrice, search = 3)
    expect(screen.getByText(/FILTERS \(3\)/)).toBeTruthy()
  })
})

import { describe, it, expect } from "vitest"
import {
  filterListingsByOwned,
  collectBadgeOptions,
  countActiveFilters,
  type EditionStats,
  type ActiveFilterState,
} from "@/lib/market/filters"

const L = (editionKey: string | null) => ({ editionKey })

describe("market filters — filterListingsByOwned", () => {
  const listings = [L("ts:1"), L("ts:2"), L(null)]
  const stats: EditionStats = new Map([
    ["ts:1", { owned: 3, locked: 1 }],
    ["ts:2", { owned: 0 }],
  ])

  it("passes through untouched when filter is 'all'", () => {
    expect(filterListingsByOwned(listings, "all", "0xabc", stats)).toBe(listings)
  })
  it("passes through when ownerKey is null", () => {
    expect(filterListingsByOwned(listings, "owned", null, stats)).toBe(listings)
  })
  it("passes through when edition counts are empty", () => {
    expect(filterListingsByOwned(listings, "owned", "0xabc", new Map())).toBe(listings)
  })
  it("keeps only owned editions (owned > 0) when filter='owned'", () => {
    const out = filterListingsByOwned(listings, "owned", "0xabc", stats)
    expect(out.map((l) => l.editionKey)).toEqual(["ts:1"])
  })
  it("keeps only not-owned editions (incl. null editionKey and owned==0) when filter='not_owned'", () => {
    const out = filterListingsByOwned(listings, "not_owned", "0xabc", stats)
    expect(out.map((l) => l.editionKey)).toEqual(["ts:2", null])
  })
})

describe("market filters — collectBadgeOptions", () => {
  it("dedupes, drops falsy slugs, and sorts", () => {
    const listings = [
      { badgeSlugs: ["rookie", "champion", ""] },
      { badgeSlugs: ["champion", "mvp"] },
      { badgeSlugs: [] },
    ]
    expect(collectBadgeOptions(listings)).toEqual(["champion", "mvp", "rookie"])
  })
  it("returns [] for no listings", () => {
    expect(collectBadgeOptions([])).toEqual([])
  })
})

describe("market filters — countActiveFilters", () => {
  const base: ActiveFilterState = {
    tiersSel: [],
    setsSel: [],
    seriesSel: [],
    teamsSel: [],
    badgesSel: [],
    minPrice: "",
    maxPrice: "",
    minDiscount: "",
    debouncedPlayer: "",
    ownedFilter: "all",
  }
  it("is 0 when nothing is active", () => {
    expect(countActiveFilters(base)).toBe(0)
  })
  it("counts each active multi-select and text input once", () => {
    expect(
      countActiveFilters({
        ...base,
        tiersSel: ["RARE"],
        badgesSel: ["mvp"],
        minPrice: "5",
        debouncedPlayer: "curry",
        ownedFilter: "owned",
      }),
    ).toBe(5)
  })
  it("counts every field when all are active", () => {
    expect(
      countActiveFilters({
        tiersSel: ["a"],
        setsSel: ["b"],
        seriesSel: ["c"],
        teamsSel: ["d"],
        badgesSel: ["e"],
        minPrice: "1",
        maxPrice: "9",
        minDiscount: "10",
        debouncedPlayer: "x",
        ownedFilter: "not_owned",
      }),
    ).toBe(10)
  })
})

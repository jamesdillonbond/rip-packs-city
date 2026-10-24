// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest"
import { loadSniperFilters, saveSniperFilters, urlHasSniperFilters } from "@/lib/sniper/saved-filters"

describe("sniper saved filters (per device, 2026-10-24)", () => {
  beforeEach(() => window.localStorage.clear())
  it("round-trips per collection and keeps collections apart", () => {
    saveSniperFilters("nba-top-shot", { tier: "rare", sort: "discount_desc", minDiscount: 20, maxPrice: 50, team: "Portland Trail Blazers", player: "" })
    expect(loadSniperFilters("nba-top-shot")).toMatchObject({ tier: "rare", minDiscount: 20, team: "Portland Trail Blazers" })
    expect(loadSniperFilters("nfl-all-day")).toBeNull()
  })
  it("drops malformed values instead of applying them", () => {
    window.localStorage.setItem("rpc_sniper_filters:nba-top-shot", JSON.stringify({ tier: 3, minDiscount: "x", maxPrice: Infinity }))
    expect(loadSniperFilters("nba-top-shot")).toEqual({})
    window.localStorage.setItem("rpc_sniper_filters:nba-top-shot", "{not json")
    expect(loadSniperFilters("nba-top-shot")).toBeNull()
  })
  it("a shared link's filters win", () => {
    expect(urlHasSniperFilters({ team: "Lakers" })).toBe(true)
    expect(urlHasSniperFilters({})).toBe(false)
  })
})

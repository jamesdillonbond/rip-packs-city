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

import { readableOn, contrastRatio } from "@/lib/accent-text"
describe("readableOn (team chips, 2026-10-24)", () => {
  it("keeps a secondary colour that reads, swaps one that does not", () => {
    expect(readableOn("#E03A3E", "#C1D32F")).not.toBe("#C1D32F") // Hawks volt on red: 2.6:1
    expect(contrastRatio("#E03A3E", readableOn("#E03A3E", "#C1D32F"))!).toBeGreaterThanOrEqual(4.5)
    expect(readableOn("#1D428A", "#FFFFFF")).toBe("#FFFFFF")
  })
})

import { sniperAlertHref, readAlertPrefill } from "@/lib/sniper/saved-filters"
describe("Sniper → Alerts prefill (2026-10-24)", () => {
  const UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  it("round-trips the board's filters, dropping defaults", () => {
    const href = sniperAlertHref({ collectionUuid: UUID, tier: "rare", player: "Damian Lillard", team: "all", maxPrice: 20, minDiscount: 0 })!
    expect(href.startsWith("/alerts?")).toBe(true)
    const pre = readAlertPrefill(href.slice("/alerts".length))!
    expect(pre).toEqual({ collectionId: UUID, tier: "RARE", player: "Damian Lillard", team: undefined, maxPrice: "20", minDiscount: undefined })
  })
  it("ignores a query that did not come from the Sniper or names no valid collection", () => {
    expect(readAlertPrefill("?collection=" + UUID)).toBeNull()
    expect(readAlertPrefill("?from=sniper&collection=constructor")).toBeNull()
    expect(sniperAlertHref({ collectionUuid: null })).toBeNull()
  })
})

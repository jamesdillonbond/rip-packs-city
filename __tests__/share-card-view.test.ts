import { describe, it, expect } from "vitest"
import { buildSeriesBars, closedMarketNote } from "@/lib/share-card-view"

describe("share-card-view · buildSeriesBars", () => {
  it("sorts series labels and returns the max for bar scaling", () => {
    const { entries, max } = buildSeriesBars({ "Series 3": 5, "Series 1": 12, "Series 2": 8 })
    expect(entries.map(([k]) => k)).toEqual(["Series 1", "Series 2", "Series 3"])
    expect(max).toBe(12)
  })

  it("names the RPC's null-series bucket and sorts it after the real series (was rendered 'SUnknown', 2026-09-04)", () => {
    const { entries } = buildSeriesBars({ SUnknown: 1414, S9: 132, S10: 3, S2: 2011 })
    expect(entries.map(([k]) => k)).toEqual(["S2", "S9", "S10", "No series"])
    expect(entries[3][1]).toBe(1414)
  })

  it("floors the max at 1 so an all-zero breakdown never divides by zero", () => {
    expect(buildSeriesBars({ "Series 1": 0 }).max).toBe(1)
    expect(buildSeriesBars({}).max).toBe(1)
    expect(buildSeriesBars({}).entries).toEqual([])
  })
})

describe("share-card-view · closedMarketNote", () => {
  it("returns null when no collection's market is closed", () => {
    expect(closedMarketNote([{ name: "Top Shot", market_closed_at: null }])).toBeNull()
    expect(closedMarketNote([])).toBeNull()
    expect(closedMarketNote(null)).toBeNull()
  })

  it("uses singular copy for exactly one closed market", () => {
    const note = closedMarketNote([
      { name: "UFC Strike", market_closed_at: "2026-05-01" },
      { name: "Top Shot", market_closed_at: null },
    ])
    expect(note).toBe(
      "UFC Strike market is closed — its moments are counted but excluded from Total FMV.",
    )
  })

  it("uses plural copy and joins names when multiple markets are closed", () => {
    const note = closedMarketNote([
      { name: "UFC Strike", market_closed_at: "2026-05-01" },
      { name: "Golazos", market_closed_at: "2026-06-01" },
    ])
    expect(note).toBe(
      "UFC Strike, Golazos markets are closed — their moments are counted but excluded from Total FMV.",
    )
  })
})

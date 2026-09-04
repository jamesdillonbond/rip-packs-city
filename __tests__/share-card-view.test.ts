import { describe, it, expect } from "vitest"
import { buildSeriesBars, closedMarketNote, shareHeadline } from "@/lib/share-card-view"

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

describe("share-card-view · shareHeadline (front door = total − stale, like the profile; 2026-09-04)", () => {
  it("headlines total minus stale and names the stale share in the caption", () => {
    const h = shareHeadline({ totalFmv: 98514.57, staleFmv: 50695.14, staleCount: 367 })
    expect(h.live).toBeCloseTo(47819.43, 2)
    expect(h.stale).toBeCloseTo(50695.14, 2)
    expect(h.caption).toBe("+ $50,695 across 367 stale-priced moments")
  })

  it("with NO stale split known (older API shape) shows the raw total and no caption — never a fabricated zero-stale claim", () => {
    const h = shareHeadline({ totalFmv: 1234.5 })
    expect(h.live).toBeCloseTo(1234.5, 2)
    expect(h.caption).toBeNull()
  })

  it("a known zero stale share has no caption; an empty wallet is $0 with no caption", () => {
    expect(shareHeadline({ totalFmv: 500, staleFmv: 0, staleCount: 0 }).caption).toBeNull()
    expect(shareHeadline({ totalFmv: 0, staleFmv: 0, staleCount: 0 }).live).toBe(0)
  })

  it("never goes negative and singularises one stale moment", () => {
    const h = shareHeadline({ totalFmv: 10, staleFmv: 25, staleCount: 1 })
    expect(h.live).toBe(0)
    expect(h.caption).toBe("+ $25 across 1 stale-priced moment")
  })
})

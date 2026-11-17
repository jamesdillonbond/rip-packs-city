import { describe, it, expect } from "vitest"
import { collectMarketFacets } from "@/lib/market/facets"

const row = (o: Record<string, unknown> = {}) => ({ setName: "Base", seriesName: "8", teamName: "Portland Fire", playerName: "Bueckers", badgeSlugs: [] as string[], ...o })

describe("collectMarketFacets", () => {
  it("collects distinct trimmed values across every row given", () => {
    const f = collectMarketFacets([row(), row({ setName: " Base ", teamName: "Seattle Storm", badgeSlugs: ["Rookie Year"] }), row({ setName: null, badgeSlugs: ["Rookie Year", "All-Star"] })])
    expect(f).toEqual({ sets: ["Base"], series: ["8"], teams: ["Portland Fire", "Seattle Storm"], players: ["Bueckers"], badges: ["All-Star", "Rookie Year"] })
  })

  it("offers no badges when the badge read failed (a badge filter would 503)", () => {
    expect(collectMarketFacets([row({ badgeSlugs: ["Rookie Year"] })], false).badges).toEqual([])
  })
})

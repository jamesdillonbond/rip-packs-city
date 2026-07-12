import { describe, it, expect } from "vitest"
import { getEntityLabels, slugifyName } from "@/lib/entity-labels"

// Pinnacle uses different domain vocabulary (Character/Franchise/Variant);
// slugifyName MUST match the Postgres regexp used in the entity RPCs or entity
// URLs stop round-tripping.

describe("getEntityLabels", () => {
  it("returns the Pinnacle vocabulary for disney-pinnacle", () => {
    const l = getEntityLabels("disney-pinnacle")
    expect(l.player).toBe("Character")
    expect(l.team).toBe("Franchise")
    expect(l.tier).toBe("Variant")
  })
  it("returns the sports vocabulary for everything else", () => {
    const l = getEntityLabels("nba-top-shot")
    expect(l.player).toBe("Player")
    expect(l.team).toBe("Team")
    expect(l.tier).toBe("Tier")
  })
})

describe("slugifyName (matches Postgres regexp_replace)", () => {
  it("trims, lower-cases, and collapses non-alphanumerics to single hyphens", () => {
    expect(slugifyName("Damian Lillard")).toBe("damian-lillard")
    expect(slugifyName("  D'Angelo Russell ")).toBe("d-angelo-russell")
  })
  it("does NOT strip leading/trailing hyphens (roundtrip parity with SQL)", () => {
    expect(slugifyName("LeBron James!")).toBe("lebron-james-")
  })
})

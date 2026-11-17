import { describe, it, expect } from "vitest"
import {
  getTierColor,
  getHighestTierLabel,
  ACHIEVEMENT_DEFS,
  type AchievementDef,
} from "@/lib/achievements"

// Locks the pure achievement helpers: getTierColor's hex mapping (case-insensitive,
// null-safe, white fallback) and getHighestTierLabel's tier-key -> label lookup
// (falls back to the raw key string when no tier matches).

describe("getTierColor", () => {
  it("maps the four known tiers to their hex colors", () => {
    expect(getTierColor("bronze")).toBe("#CD7F32")
    expect(getTierColor("silver")).toBe("#C0C0C0")
    expect(getTierColor("gold")).toBe("#F59E0B")
    expect(getTierColor("platinum")).toBe("#E0E0FF")
  })

  it("is case-insensitive", () => {
    expect(getTierColor("GOLD")).toBe("#F59E0B")
    expect(getTierColor("Bronze")).toBe("#CD7F32")
  })

  it("falls back to white for unknown, empty, or nullish tiers", () => {
    expect(getTierColor("diamond")).toBe("#FFFFFF")
    expect(getTierColor("")).toBe("#FFFFFF")
    expect(getTierColor(null as unknown as string)).toBe("#FFFFFF")
    expect(getTierColor(undefined as unknown as string)).toBe("#FFFFFF")
  })
})

describe("getHighestTierLabel", () => {
  const packHunter = ACHIEVEMENT_DEFS.pack_hunter

  it("returns the matching tier's label for a known key", () => {
    expect(getHighestTierLabel(packHunter, "gold")).toBe("Gold")
    expect(getHighestTierLabel(packHunter, "platinum")).toBe("Platinum")
  })

  it("falls back to the raw key when the tier key is not present in the def", () => {
    expect(getHighestTierLabel(packHunter, "diamond")).toBe("diamond")
    // diamond_hands only has a 'gold' tier, so 'bronze' is unmatched
    expect(getHighestTierLabel(ACHIEVEMENT_DEFS.diamond_hands, "bronze")).toBe("bronze")
  })

  it("returns the empty string when passed an empty key with no empty-key tier", () => {
    const empty: AchievementDef = { emoji: "", name: "", description: "", tiers: [] }
    expect(getHighestTierLabel(empty, "")).toBe("")
  })
})

import { describe, it, expect } from "vitest"
import {
  classifyAlldayBadges,
  ALLDAY_BADGE_RULES,
  ALLDAY_BADGE_COLORS,
} from "@/lib/allday-badges"

// NFL All Day set-name → badge classifier. Locks: case-insensitive substring
// match, empty/null → [], descending-priority ordering, and that Super Bowl
// (priority 10) leads over lower-priority matches in the same set name.

describe("classifyAlldayBadges", () => {
  it("returns [] for empty or unmatched names", () => {
    expect(classifyAlldayBadges("")).toEqual([])
    // @ts-expect-error runtime guard for null
    expect(classifyAlldayBadges(null)).toEqual([])
    expect(classifyAlldayBadges("regular season set")).toEqual([])
  })

  it("matches case-insensitively", () => {
    expect(classifyAlldayBadges("SUPER BOWL LVIII")).toEqual(["Super Bowl"])
    expect(classifyAlldayBadges("Rookie Class")).toEqual(["Rookie"])
  })

  it("matches alias patterns", () => {
    expect(classifyAlldayBadges("class of 2024")).toEqual(["Rookie"])
    expect(classifyAlldayBadges("wild card weekend")).toEqual(["Playoffs"])
    expect(classifyAlldayBadges("all-pro selection")).toEqual(["Pro Bowl"])
  })

  it("orders multiple matches by descending priority", () => {
    // 'super bowl' → Super Bowl (10); 'rookie' → Rookie (9)
    const res = classifyAlldayBadges("rookie super bowl moment")
    expect(res[0]).toBe("Super Bowl")
    expect(res).toContain("Rookie")
  })
})

describe("ALLDAY_BADGE_COLORS", () => {
  it("has a color class for every rule title", () => {
    for (const rule of ALLDAY_BADGE_RULES) {
      expect(ALLDAY_BADGE_COLORS[rule.badgeTitle]).toBeTruthy()
    }
  })
})

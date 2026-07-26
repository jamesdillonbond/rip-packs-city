import { describe, it, expect } from "vitest"
import { momentSubject, notableTagLabel, specialSerialLabel } from "@/lib/moment-labels"

describe("momentSubject — SEO subject derivation", () => {
  it("prefers the player name (trimmed)", () => {
    expect(momentSubject("  LeBron James  ", "Lakers", "Dunk", "x")).toBe("LeBron James")
  })
  it("team moment (no player) → '<team> <play>', dropping Unknown play", () => {
    expect(momentSubject(null, "Chicago Bulls", "Reel", null)).toBe("Chicago Bulls Reel")
    expect(momentSubject(null, "Chicago Bulls", "Unknown", null)).toBe("Chicago Bulls")
  })
  it("falls back to name, then 'Moment'", () => {
    expect(momentSubject(null, null, null, "Cool Set")).toBe("Cool Set")
    expect(momentSubject(null, null, null, null)).toBe("Moment")
  })
})

describe("notableTagLabel", () => {
  it.each([
    ["#1", "Serial #1"],
    ["jersey", "Jersey Match"],
    ["last_mint", "Perfect Serial"],
    ["some_other_tag", "some other tag"],
  ])("%s → %s", (tag, label) => {
    expect(notableTagLabel(tag)).toBe(label)
  })
})

describe("specialSerialLabel", () => {
  it.each([
    ["first_serial", "#1 Serial"],
    ["jersey_match", "Jersey Match"],
    ["perfect_mint", "Perfect Serial"],
    ["last_serial", "Perfect Serial"],
    ["birthdate_serial", "Birthdate"],
    ["mystery_kind", "mystery kind"],
  ])("%s → %s", (badge, label) => {
    expect(specialSerialLabel(badge)).toBe(label)
  })
})

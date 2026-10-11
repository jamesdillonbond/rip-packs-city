import { describe, it, expect } from "vitest"
import { buildEditionBadgeMap, badgeInfoForRow } from "@/lib/collection/badge-match"

// Badges are per EDITION. The binder used to key them player::series and keep
// the highest score, so every moment of a player in a series wore that
// player's best edition's badges (2026-10-10, Donovan Clingan #1/1 showed
// "Top Shot Debut" from his Rookie Debut).

const editions = [
  { external_id: "164:5723", player_name: "Donovan Clingan", series_number: 7, badge_score: 8, badge_titles: ["Rookie Premiere", "Rookie Year", "Top Shot Debut"], is_three_star_rookie: true },
  { external_id: "176:7003", player_name: "Donovan Clingan", series_number: 7, badge_score: 3, badge_titles: ["Rookie Premiere", "Rookie Year", "Rookie Mint"], is_three_star_rookie: false },
  { external_id: "219:7408::17", player_name: "X", series_number: 8, badge_score: 2, badge_titles: ["Rookie Year", "Not A Pill"] },
]
const map = buildEditionBadgeMap(editions)

describe("edition-grain badge matching", () => {
  it("the 1/1 Ultimate gets ITS badges, not the higher-scoring Rookie Debut's", () => {
    const b = badgeInfoForRow({ editionKey: "176:7003" }, map)
    expect(b?.badge_titles).toEqual(["Rookie Premiere", "Rookie Year", "Rookie Mint"])
    expect(b?.badge_titles).not.toContain("Top Shot Debut")
    expect(b?.is_three_star_rookie).toBe(false)
  })

  it("a parallel matches its own key and titles are filtered to the pill set", () => {
    expect(badgeInfoForRow({ editionKey: "219:7408::17" }, map)?.badge_titles).toEqual(["Rookie Year"])
  })

  it("an edition with no badge row gets null, never a sibling's badges", () => {
    expect(badgeInfoForRow({ editionKey: "999:1" }, map)).toBeNull()
  })

  it("a row with no edition key gets null", () => {
    expect(badgeInfoForRow({ editionKey: null }, map)).toBeNull()
    expect(badgeInfoForRow({ editionKey: "  " }, map)).toBeNull()
  })
})

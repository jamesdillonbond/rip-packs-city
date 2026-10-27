import { describe, it, expect } from "vitest"
import { boardSeed } from "@/app/special-serial-owners/board-seed"

/**
 * /special-serial-owners URL seed. ⛔ A PRESENT `?collection=` the board does not cover is refused (null),
 * never mapped to Top Shot (2026-10-27): that would answer a Candy / Pinnacle question with Top Shot's
 * holders — substitution. Only an ABSENT param defaults.
 */
describe("boardSeed", () => {
  it("an absent collection defaults to Top Shot", () => {
    expect(boardSeed({ player: "LeBron James" })).toEqual({ player: "LeBron James", collection: "nba-top-shot" })
    expect(boardSeed(undefined)).toEqual({ player: "", collection: "nba-top-shot" })
  })
  it("both spellings of the two covered collections are accepted", () => {
    expect(boardSeed({ collection: "nfl-all-day" }).collection).toBe("nfl-all-day")
    expect(boardSeed({ collection: "nfl_all_day" }).collection).toBe("nfl-all-day")
    expect(boardSeed({ collection: "NBA-Top-Shot" }).collection).toBe("nba-top-shot")
  })
  it("a present collection the board does not cover is REFUSED, never Top Shot", () => {
    for (const c of ["candy-mlb", "disney-pinnacle", "panini-blockchain", "nope"]) {
      expect(boardSeed({ player: "Shohei Ohtani", collection: c }).collection).toBeNull()
    }
  })
  it("the player is trimmed and capped", () => {
    expect(boardSeed({ player: `  ${"x".repeat(100)}  ` }).player).toHaveLength(80)
  })
})

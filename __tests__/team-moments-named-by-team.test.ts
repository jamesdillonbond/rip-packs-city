import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { teamMomentSubject } from "@/lib/topshot-edition-name"

// R8 (2026-10-04): 584 Top Shot TEAM Moments were named by their set alone, so a set page listed
// 66 Moments all called "Clamps". A team Moment is now named by its team, the same shape as a
// player Moment: "Boston Celtics — Clamps". Both name writers (the sale ingest and the edition
// hydrator) go through teamMomentSubject.
describe("teamMomentSubject — the 'who' half of a Top Shot edition name", () => {
  it("prefers the player", () => {
    expect(teamMomentSubject("Jayson Tatum", "Boston Celtics")).toBe("Jayson Tatum")
  })

  it("falls back to the team for a team Moment", () => {
    expect(teamMomentSubject(null, "Boston Celtics")).toBe("Boston Celtics")
    expect(teamMomentSubject("  ", " Boston Celtics ")).toBe("Boston Celtics")
  })

  it("never uses Dapper's on-chain sentinel as a subject", () => {
    expect(teamMomentSubject("<invalid Value>", "Denver Nuggets")).toBe("Denver Nuggets")
    expect(teamMomentSubject("<invalid Value>", "<invalid Value>")).toBeNull()
  })

  it("returns null when neither is known, so the name is the set alone", () => {
    expect(teamMomentSubject(undefined, null)).toBeNull()
  })
})

describe("both Top Shot name writers use it", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8")

  it("the sale ingest names a team Moment by teamAtMoment", () => {
    expect(read("app/api/ingest/route.ts")).toMatch(
      /name:\s*\[teamMomentSubject\(moment\.play\.stats\?\.playerName,\s*moment\.play\.stats\?\.teamAtMoment\)/,
    )
  })

  it("the hydrator names a team Moment by its teamName", () => {
    expect(read("lib/editions-hydrate.ts")).toMatch(/teamMomentSubject\(playerName,\s*meta\?\.teamName\)/)
  })

  it("the hydrator writes the team as a team Moment's player_name (convention player_name = team_name)", () => {
    expect(read("lib/editions-hydrate.ts")).toMatch(/player_name:\s*subject,/)
  })
})

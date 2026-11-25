// 2026-11-24 — POST /api/backfill-edition-names filled home_team from TeamAtMoment (the
// PLAYER's team) ahead of HomeTeamName, so a Moment whose player was on the away side
// stored its own team as both home and away (298 Top Shot editions: "Clippers vs
// Clippers"). Home/away must come only from the game's HomeTeamName/AwayTeamName.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = readFileSync(join(process.cwd(), "app/api/backfill-edition-names/route.ts"), "utf8")

describe("backfill-edition-names home/away", () => {
  const homeLine = src.split("\n").find((l) => /const homeTeam\s*=/.test(l)) ?? ""
  const awayLine = src.split("\n").find((l) => /const awayTeam\s*=/.test(l)) ?? ""

  it("reads home_team from HomeTeamName, never the player's TeamAtMoment", () => {
    expect(homeLine).toMatch(/HomeTeamName/)
    expect(homeLine).not.toMatch(/TeamAtMoment/i)
  })

  it("reads away_team from AwayTeamName, never a TeamAtMoment field", () => {
    expect(awayLine).toMatch(/AwayTeamName/)
    expect(awayLine).not.toMatch(/TeamAtMoment/i)
  })
})

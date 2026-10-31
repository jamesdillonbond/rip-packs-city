// 2026-10-31: All Day's team-level Moments list the TEAM as the player, so
// /nfl-all-day/player/detroit-lions is a real page. Its follow goes to the team page.
// Pinnacle characters whose franchise shares their name (Aladdin, Bambi) are NOT teams.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { isTeamSubject } from "@/lib/player-route"

describe("isTeamSubject", () => {
  it("is true for an All Day team-level row (name = team, slug = team slug)", () => {
    expect(isTeamSubject("nfl-all-day", { name: "Detroit Lions", team: "Detroit Lions", player_slug: "detroit-lions", team_slug: "detroit-lions" })).toBe(true)
    expect(isTeamSubject("nfl-all-day", { name: "Detroit Lions", team: "detroit lions ", player_slug: null, team_slug: null })).toBe(true)
  })
  it("is false for a real player on that team", () => {
    expect(isTeamSubject("nfl-all-day", { name: "Jared Goff", team: "Detroit Lions", player_slug: "jared-goff", team_slug: "detroit-lions" })).toBe(false)
    expect(isTeamSubject("nba-top-shot", { name: "LeBron James", team: null, player_slug: "lebron-james", team_slug: null })).toBe(false)
  })
  it("is false for a Pinnacle character named after its franchise", () => {
    expect(isTeamSubject("disney-pinnacle", { name: "Aladdin", team: "Aladdin", player_slug: "aladdin", team_slug: "aladdin" })).toBe(false)
  })
  it("the player page routes a team-subject follow to the team page", () => {
    const page = readFileSync("app/(collections)/[collection]/player/[slug]/page.tsx", "utf8")
    expect(page).toMatch(/isTeamSubject\(collection, \{/)
    expect(page).toMatch(/data-rpc-player-follow="team-subject" href=\{teamHref\}/)
  })
})

import { describe, it, expect } from "vitest"
import { playerJsonLd, playerPageMetadata } from "@/lib/seo"

// 2026-11-04: All Day / Top Shot TEAM Moments carry the team as their player name, so 80 player
// pages (47 Top Shot, 33 All Day) are a team — /nfl-all-day/player/detroit-lions. The page already
// routed its Follow button to the team page (isTeamSubject, 10-31), but the meta description read
// "Detroit Lions (Player) on NFL All Day. Team: Detroit Lions." and the JSON-LD declared a Person
// affiliated with the SportsTeam of the same name. A team page must not claim to be a person.
const teamRow = { name: "Detroit Lions", team: "Detroit Lions", team_slug: "detroit-lions", edition_count: 11 }
const personRow = { name: "Amon-Ra St. Brown", team: "Detroit Lions", team_slug: "detroit-lions", edition_count: 20 }

function graphNode(ld: unknown): Record<string, unknown> {
  return ((ld as { "@graph": Record<string, unknown>[] })["@graph"])[0]
}

describe("a team-subject player page never claims a person", () => {
  it("JSON-LD: a team row is a SportsTeam with no self-affiliation; a person row stays a Person", () => {
    const t = graphNode(playerJsonLd(teamRow, "nfl-all-day", "detroit-lions"))
    expect(t["@type"]).toBe("SportsTeam")
    expect(t).not.toHaveProperty("affiliation")
    const p = graphNode(playerJsonLd(personRow, "nfl-all-day", "amon-ra-st-brown"))
    expect(p["@type"]).toBe("Person")
    expect(p.affiliation).toEqual({ "@type": "SportsTeam", name: "Detroit Lions" })
  })

  it("metadata: a team row's description has no '(Player)' and no 'Team: <itself>.'", () => {
    const d = String(playerPageMetadata(teamRow, "nfl-all-day", "detroit-lions").description)
    expect(d).not.toContain("(Player)")
    expect(d).not.toContain("Team: Detroit Lions.")
    expect(d).toContain("Detroit Lions (Team) on")
    const pd = String(playerPageMetadata(personRow, "nfl-all-day", "amon-ra-st-brown").description)
    expect(pd).toContain("(Player)")
    expect(pd).toContain("Team: Detroit Lions.")
  })

  it("a Pinnacle character sharing its franchise's name stays a character (isTeamSubject never fires there)", () => {
    const d = String(playerPageMetadata({ name: "Bambi", team: "Bambi", is_character: true }, "disney-pinnacle", "bambi").description)
    expect(d).toContain("(Character)")
  })
})

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { momentSubjectHref } from "@/lib/entity-href"

// The series page's "Top Players" card for a TEAM moment links to /team/, never /player/.
//
// An internal-link crawl on 2026-09-29 found /nba-top-shot/series/series-4 linking
// "Los Angeles Lakers" to /nba-top-shot/player/los-angeles-lakers, which is a 404: a team
// moment's subject is a franchise. get_series_rollups now returns players[].team_name, set only
// when the subject is the team (pinned in supabase/tests/get_series_editions.sql, claim 5), and
// the page routes that row through momentSubjectHref.
//
// Asserted on source for the wiring (same reason as series-partial-rollup-says-it-is-partial:
// a real render needs a Supabase client and two RPCs), plus the helper's output for the two
// team shapes the rollup carries.

const src = readFileSync(
  join(process.cwd(), "app", "(collections)", "[collection]", "series", "[slug]", "page.tsx"),
  "utf8",
)

describe("series Top Players: a team moment links to its team page", () => {
  it("routes a row carrying teamName through momentSubjectHref", () => {
    expect(src).toMatch(/href=\{\(p\.teamName && momentSubjectHref\(collection, p\.playerName, p\.teamName\)\)/)
  })

  it("carries teamName from BOTH bases: the rollup and the editions fallback", () => {
    expect(src).toMatch(/teamName: p\.team_name \?\? null/)
    // The fallback must apply the team rule itself: e.team_name is set on EVERY edition,
    // so copying it unconditionally would send LeBron James to the Lakers' page.
    expect(src).toMatch(/teamName: isTeamMoment\(pn, e\.team_name\) \? \(e\.team_name \?\? null\) : null/)
  })

  it("builds /team/ URLs for both team-moment shapes, not /player/", () => {
    expect(momentSubjectHref("nba-top-shot", "Los Angeles Lakers", "Los Angeles Lakers")).toBe(
      "/nba-top-shot/team/los-angeles-lakers",
    )
    // All Day stores a team moment's subject as the city prefix.
    expect(momentSubjectHref("nfl-all-day", "Denver", "Denver Broncos")).toBe("/nfl-all-day/team/denver-broncos")
  })
})

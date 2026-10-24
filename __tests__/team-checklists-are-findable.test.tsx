// @vitest-environment jsdom
//
// 2026-10-24 — webz_80 (the one real concierge user) on the Top Shot overview:
// "I can't easily find the team set pages", then on /teams/nba/pistons: "I can't
// see the checklist from the team hub." Both were true:
//   * no tab, card or link on a collection's Overview led to a team, and the
//     header's My Teams is signed-in only;
//   * the franchise hub's only route to the checklist was a link at the very
//     bottom of each panel, under a paginated editions grid, and the word
//     "checklist" appeared nowhere on the page.
// Pinned here: the Overview of every collection with team pages links to the
// team directory; collections without them do not; the hub panel names the
// checklist and links it BEFORE its "Top editions" grid.
import React from "react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { COLLECTIONS } from "@/lib/collections"

vi.mock("@/components/InsiderSignalsPanel", () => ({ default: () => <div /> }))
vi.mock("@/components/marketplace-status", () => ({ MarketplaceStatusBanner: () => null }))

import OverviewPage from "@/app/(collections)/[collection]/overview/CollectionOverviewClient"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "x" }) }) as unknown as Response),
  )
}

describe("Overview: team checklists are reachable", () => {
  const withTeams = COLLECTIONS.filter((c) => c.teamPages)
  const withoutTeams = COLLECTIONS.filter((c) => !c.teamPages && c.published)

  it("the registry flag covers the leagues league_collections maps (NBA/WNBA, NFL, LALIGA, MLB)", () => {
    expect(withTeams.map((c) => c.id).sort()).toEqual(["candy-mlb", "laliga-golazos", "nba-top-shot", "nfl-all-day"])
  })

  it.each(withTeams.map((c) => c.id))("%s links to the team directory", (id) => {
    stubFetch()
    render(<OverviewPage collection={id} />)
    const link = screen.getByText(/Browse teams/i).closest("a")
    expect(link?.getAttribute("href")).toBe("/teams")
    expect(screen.getByText("Team checklists")).toBeTruthy()
  })

  it.each(withoutTeams.map((c) => c.id))("%s (no team pages) shows no team-checklist card", (id) => {
    stubFetch()
    render(<OverviewPage collection={id} />)
    expect(screen.queryByText(/Browse teams/i)).toBeNull()
  })
})

describe("Franchise hub: the checklist leads each collection panel", () => {
  const src = readFileSync(join(__dirname, "..", "app", "teams", "[league]", "[slug]", "page.tsx"), "utf8")
  const panel = src.slice(src.indexOf("function CollectionPanel"), src.indexOf("function PaniniPanel"))

  it("names the checklist in the panel", () => {
    expect(panel).toMatch(/\{hub\.team_name\} checklist/)
  })

  it("links the checklist BEFORE the Top editions grid", () => {
    const firstChecklistLink = panel.indexOf("href={teamHref}")
    const topEditions = panel.indexOf("Top editions")
    expect(firstChecklistLink).toBeGreaterThan(-1)
    expect(topEditions).toBeGreaterThan(-1)
    expect(firstChecklistLink, "the checklist link must come before the editions grid").toBeLessThan(topEditions)
  })
})

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render } from "@testing-library/react"

// 2026-09-26: PopularOnCollection rendered on /panini-blockchain/overview and
// /market and linked 18 editions + 12 players + 12 sets — all 404, because the
// entity routes resolve collections through lib/collection-slug and Panini is
// not in it. The fan-out now renders only for a collection the facade knows.
// 2026-09-27: Panini JOINED the facade; see the re-pin note below.

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}))
const fetchers = vi.hoisted(() => ({ hubs: vi.fn(), links: vi.fn() }))
vi.mock("@/lib/entity/popular-on-collection-fetchers", () => ({
  fetchHubRows: fetchers.hubs,
  fetchLinkRows: fetchers.links,
}))

import PopularOnCollection from "@/components/entity/PopularOnCollection"

beforeEach(() => {
  fetchers.hubs.mockReset().mockResolvedValue({
    data: { editions: [{ set_name: "Team Badges", player_name: "Norway", team_name: null }], series: [] },
    ok: true,
  })
  fetchers.links.mockReset().mockResolvedValue({
    data: [{ external_id: "packcard-1", player_name: "Norway", team_name: null, play_type: null, set_name: "Team Badges" }],
    ok: true,
  })
})

describe("PopularOnCollection links only into entity pages that exist", () => {
  // Re-pinned 2026-09-27: Panini joined the facade (its entity pages exist now),
  // so the "not in the facade → render nothing" property is held by a collection
  // that is still outside it (rwa), and Panini is held to the finer property
  // that replaced it: no link to a player page that does not exist.
  it("renders nothing (and reads nothing) for a collection outside the facade (rwa)", async () => {
    const out = await PopularOnCollection({ collection: "rwa" })
    expect(out).toBeNull()
    expect(fetchers.links).not.toHaveBeenCalled()
    expect(fetchers.hubs).not.toHaveBeenCalled()
  })

  it("Panini: a nation (Team Badges) or dual-player card never becomes a /player/ link", async () => {
    fetchers.hubs.mockResolvedValue({
      data: {
        editions: [
          { set_name: "Team Badges", player_name: "Norway", team_name: null },
          { set_name: "Color Blast Duals", player_name: "Lionel Messi | Angel Di Maria", team_name: null },
          { set_name: "World Cup Posters", player_name: "Dallas", team_name: null },
          // control: a real player subject still links
          { set_name: "Base Prizms Blue", player_name: "Lionel Messi", team_name: null },
        ],
        series: [],
      },
      ok: true,
    })
    const out = await PopularOnCollection({ collection: "panini-blockchain" })
    expect(out).not.toBeNull()
    const { container } = render(out as any)
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "")
    expect(hrefs).toContain("/panini-blockchain/player/lionel-messi")
    expect(hrefs.filter((h) => h.includes("/player/"))).toEqual(["/panini-blockchain/player/lionel-messi"])
    expect(hrefs.some((h) => h.startsWith("/panini-blockchain/edition/"))).toBe(true)
    // No team hub either: Panini team_name is NULL (a nation is not a team).
    expect(hrefs.some((h) => h.includes("/team/"))).toBe(false)
  })

  it("control: a facade collection (candy-mlb) still renders its fan-out", async () => {
    const out = await PopularOnCollection({ collection: "candy-mlb" })
    expect(out).not.toBeNull()
    const { container } = render(out as any)
    expect(container.querySelector('a[href^="/candy-mlb/"]')).not.toBeNull()
  })
})

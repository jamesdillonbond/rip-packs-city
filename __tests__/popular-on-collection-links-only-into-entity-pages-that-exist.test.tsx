// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render } from "@testing-library/react"

// 2026-09-26: PopularOnCollection rendered on /panini-blockchain/overview and
// /market and linked 18 editions + 12 players + 12 sets — all 404, because the
// entity routes resolve collections through lib/collection-slug and Panini is
// not in it. The fan-out now renders only for a collection the facade knows.

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
  it("renders nothing (and reads nothing) for Panini, whose entity routes 404", async () => {
    const out = await PopularOnCollection({ collection: "panini-blockchain" })
    expect(out).toBeNull()
    expect(fetchers.links).not.toHaveBeenCalled()
    expect(fetchers.hubs).not.toHaveBeenCalled()
  })

  it("control: a facade collection (candy-mlb) still renders its fan-out", async () => {
    const out = await PopularOnCollection({ collection: "candy-mlb" })
    expect(out).not.toBeNull()
    const { container } = render(out as any)
    expect(container.querySelector('a[href^="/candy-mlb/"]')).not.toBeNull()
  })
})

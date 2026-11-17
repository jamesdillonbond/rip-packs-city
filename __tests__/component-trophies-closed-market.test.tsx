// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"
import TrophiesBoardClient from "@/app/insights/trophies/TrophiesBoardClient"

// 2026-10-18 (Trevor: Panini and UFC grails belong on the Trophy Room): UFC
// Strike's Flow market is closed, so its grails' values are the last ones seen
// before it closed. They stay in the grid labelled as such, and never lead the
// hero or set "Top value".
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))

const row = (over: Record<string, unknown>) => ({
  edition_id: String(Math.random()), external_id: "x", collection: "nba_top_shot", collection_id: null,
  name: null, player_name: "P", set_name: "S", team_name: null, tier: "ULTIMATE", series: 1,
  circulation_count: 1, thumbnail_url: null, video_url: null, is_one_of_one: true, is_ultimate: false,
  fmv_usd: 100, confidence: null, fmv_computed_at: null, ...over,
})

afterEach(cleanup)

describe("Trophy Room — a closed market's value is historical", () => {
  const rows = [
    row({ collection: "ufc_strike", player_name: "UFC Grail", fmv_usd: 6300 }),
    row({ collection: "nba_top_shot", player_name: "TS Grail", fmv_usd: 900 }),
    row({ collection: "panini_blockchain", player_name: "Panini Grail", fmv_usd: 500 }),
  ]

  it("labels the UFC value as last seen before the market closed", () => {
    render(<TrophiesBoardClient initialRows={rows as never} initialFetchedAt={null} />)
    expect(screen.getAllByText(/last seen · market closed/).length).toBeGreaterThan(0)
  })

  it("keeps the closed-market grail out of the hero and out of Top value", () => {
    render(<TrophiesBoardClient initialRows={rows as never} initialFetchedAt={null} />)
    const hero = screen.getByLabelText("Featured trophies")
    expect(within(hero).queryByText("UFC Grail")).toBeNull()
    expect(within(hero).getByText("TS Grail")).toBeTruthy()
    const kpis = screen.getByLabelText("Summary")
    expect(kpis.textContent).not.toMatch(/6,?300/)
  })

  // 2026-10-18 (Trevor: "All supported collections should be usable there"):
  // one tab per PUBLISHED collection, from the registry.
  it("offers a tab for every published collection", () => {
    render(<TrophiesBoardClient initialRows={rows as never} initialFetchedAt={null} />)
    for (const label of ["NBA Top Shot", "NFL All Day", "LaLiga Golazos", "Disney Pinnacle", "UFC Strike", "Candy MLB", "Panini Blockchain"]) {
      expect(screen.getByRole("tab", { name: label }), label).toBeTruthy()
    }
  })

  it("links a Pinnacle grail to its pin page and badges a non-Ultimate top tier by its own name", () => {
    const pinRow = row({ collection: "disney_pinnacle", external_id: "render-abc", player_name: "Pin Grail", tier: "Legendary Edition", is_one_of_one: false, is_top_tier: true, circulation_count: 5, fmv_usd: 50 })
    const gzRow = row({ collection: "laliga_golazos", external_id: "gz-1", player_name: "GZ Grail", tier: "LEGENDARY", is_one_of_one: false, is_top_tier: true, circulation_count: 9, fmv_usd: 40 })
    const { container } = render(<TrophiesBoardClient initialRows={[pinRow, gzRow] as never} initialFetchedAt={null} />)
    expect(container.querySelector('a[href="/pinnacle/moment/render-abc"]')).not.toBeNull()
    expect(container.querySelector('a[href="/laliga-golazos/edition/gz-1"]')).not.toBeNull()
    expect(container.textContent).toContain("/9 LEGENDARY")
    expect(container.textContent).not.toContain("/9 ULTIMATE")
  })
})

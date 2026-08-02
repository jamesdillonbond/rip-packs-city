// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// TrophiesBoardClient renders the public Trophy Room grid; each tile's edition
// drill-down link is built from the row's long-form collection string. The view
// currently carries only Top Shot + All Day, but the client renders whatever
// rows it's given — this pins that a UFC grail (were one ever surfaced) links to
// canonical "ufc", not the "ufc-strike" alias a naive _→- replace would emit.
// Lives under app/insights/**/*Client.tsx, which the component gate measures.

import TrophiesBoardClient, { type Row } from "@/app/insights/trophies/TrophiesBoardClient"

const ufcRow: Row = {
  edition_id: "e1",
  external_id: "5:12",
  collection: "ufc_strike",
  collection_id: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  name: "Jon Jones",
  player_name: "Jon Jones",
  set_name: "Genesis",
  team_name: null,
  tier: "CHALLENGER",
  series: 0,
  circulation_count: 1,
  thumbnail_url: null,
  video_url: null,
  is_one_of_one: true,
  is_ultimate: false,
  fmv_usd: null,
  confidence: null,
  fmv_computed_at: null,
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(url).includes("/api/profile/me")
            ? {}
            : { rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } },
      } as Response),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("TrophiesBoardClient", () => {
  it("links a UFC grail to the canonical /ufc/edition slug, not the ufc-strike alias", () => {
    const { container } = render(
      <TrophiesBoardClient initialRows={[ufcRow]} initialFetchedAt="2026-08-02T00:00:00Z" />,
    )
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/ufc/edition/5%3A12")
    expect(hrefs.some((h) => h?.startsWith("/ufc-strike/"))).toBe(false)
  })
})

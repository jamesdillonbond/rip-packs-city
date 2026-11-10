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

// 2026-11-09: v_insights_trophies no longer flags a circulation-1 edition held by more than one
// card as 1-of-1 (183 Candy editions). Such a row can still appear as top tier; its badge must not
// restate the single-copy claim as "1 OF 1" or "/1".
describe("TrophiesBoardClient — a contradicted circulation of 1", () => {
  const candyRow = {
    ...ufcRow,
    edition_id: "c1",
    external_id: "c:2022-all-star-tricons:x",
    collection: "candy_mlb",
    collection_id: "209ade70-32c5-4470-bc7c-4793d660f713",
    tier: "LEGENDARY",
    circulation_count: 1,
    is_one_of_one: false,
    is_top_tier: true,
  } as Row
  it("shows the tier word, never '1 OF 1' or '/1'", () => {
    const { container } = render(<TrophiesBoardClient initialRows={[candyRow]} initialFetchedAt="2026-08-02T00:00:00Z" />)
    const text = container.textContent ?? ""
    expect(text).toContain("LEGENDARY")
    expect(text).not.toContain("1 OF 1")
    expect(text).not.toMatch(/\/1 LEGENDARY/)
  })
  it("no-change control: a genuine 1-of-1 still says 1 OF 1, a /10 top tier still shows /10", () => {
    const real = { ...candyRow, edition_id: "c2", is_one_of_one: true } as Row
    const ten = { ...candyRow, edition_id: "c3", circulation_count: 10 } as Row
    const { container } = render(<TrophiesBoardClient initialRows={[real, ten]} initialFetchedAt="2026-08-02T00:00:00Z" />)
    const text = container.textContent ?? ""
    expect(text).toContain("1 OF 1")
    expect(text).toMatch(/\/10 LEGENDARY/)
  })
})

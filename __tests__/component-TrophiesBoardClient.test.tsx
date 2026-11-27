// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

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
    expect(text).not.toContain("1 minted")
    expect(text).toContain("count unconfirmed")
  })
  it("no-change control: a genuine 1-of-1 still says 1 OF 1, a /10 top tier still shows /10", () => {
    const real = { ...candyRow, edition_id: "c2", is_one_of_one: true } as Row
    const ten = { ...candyRow, edition_id: "c3", circulation_count: 10 } as Row
    const { container } = render(<TrophiesBoardClient initialRows={[real, ten]} initialFetchedAt="2026-08-02T00:00:00Z" />)
    const text = container.textContent ?? ""
    expect(text).toContain("1 OF 1")
    expect(text).toMatch(/\/10 LEGENDARY/)
    expect(text).toContain("1 minted")
    expect(text).toContain("10 minted")
  })
})

// 2026-11-14 (fresh-eyes review of /insights): over a failed seed the strip printed
// "Trophies 0 · 1-of-1s 0 · With a price 0" under the "unknown, not zero" banner — what
// crawlers, no-JS readers and everyone before the refetch lands see.
describe("TrophiesBoardClient — a failed seed has no KPIs", () => {
  it("renders em-dashes, never measured zeros, while the seed is failed", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    const { container } = render(
      <TrophiesBoardClient initialRows={[]} initialFetchedAt={null} initialDegraded={{ failed: ["Trophies"], truncated: [], total: 1, headline: "Trophies is temporarily unavailable." }} />,
    )
    const values = Array.from(container.querySelectorAll(".rpc-tr-kpi-value")).map((n) => n.textContent)
    expect(values.length).toBe(4)
    expect(values.every((v) => v === "—")).toBe(true)
  })
  it("a successful empty read still says 0 (the no-change control)", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    const { container } = render(<TrophiesBoardClient initialRows={[]} initialFetchedAt="2026-11-14T00:00:00Z" />)
    const first = container.querySelector(".rpc-tr-kpi-value")?.textContent
    expect(first).toBe("0")
  })
})

// 2026-11-26: Panini covers many leagues and brands — a second pill row narrows it. Candy gets none: its
// grails on this board are baseball only (Trevor 11-09), so a brand row there would offer empty picks.
describe("TrophiesBoardClient — league / brand pills", () => {
  const index = { properties: [{ slug: "nba", name: "NBA", heading: "leagues", sort_order: 10 }, { slug: "nfl", name: "NFL", heading: "leagues", sort_order: 20 }], setProperty: {} }
  const stub = (indexOk: boolean) => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      const isIndex = url.includes("-properties")
      const body = isIndex ? index : { rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } }
      return { ok: isIndex ? indexOk : true, status: isIndex && !indexOk ? 503 : 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    }))
    return calls
  }
  it("appears for Panini, sends the pick as ?property=, and is dropped when the collection changes", async () => {
    const calls = stub(true)
    const { getByRole, queryByTestId, findByTestId } = render(<TrophiesBoardClient initialRows={[]} initialFetchedAt={null} />)
    expect(queryByTestId("trophies-league-pills")).toBeNull()
    fireEvent.click(getByRole("tab", { name: /Panini/ }))
    const pills = await findByTestId("trophies-league-pills")
    expect([...pills.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["All", "NBA", "NFL"])
    expect(pills.textContent?.toLowerCase()).not.toContain("property")
    fireEvent.click(getByRole("button", { name: "NFL" }))
    await waitFor(() => expect(calls.some((u) => u.includes("collection=panini_blockchain") && u.includes("property=nfl"))).toBe(true))
    calls.length = 0
    fireEvent.click(getByRole("tab", { name: /Top Shot/ }))
    await waitFor(() => expect(calls.some((u) => u.includes("collection=nba_top_shot"))).toBe(true))
    expect(calls.some((u) => u.includes("property="))).toBe(false)
    expect(queryByTestId("trophies-league-pills")).toBeNull()
  })
  it("Candy gets no brand row and asks for no brand index (its grails here are baseball only)", async () => {
    const calls = stub(true)
    const { getByRole, queryByTestId } = render(<TrophiesBoardClient initialRows={[]} initialFetchedAt={null} />)
    fireEvent.click(getByRole("tab", { name: "Candy" }))
    await waitFor(() => expect(calls.some((u) => u.includes("collection=candy_mlb"))).toBe(true))
    expect(calls.some((u) => u.includes("-properties"))).toBe(false)
    expect(queryByTestId("trophies-league-pills")).toBeNull()
  })
  it("a failed league index shows no row and sends no property", async () => {
    const calls = stub(false)
    const { getByRole, queryByTestId } = render(<TrophiesBoardClient initialRows={[]} initialFetchedAt={null} />)
    fireEvent.click(getByRole("tab", { name: /Panini/ }))
    await waitFor(() => expect(calls.some((u) => u.includes("-properties"))).toBe(true))
    await waitFor(() => expect(calls.some((u) => u.includes("collection=panini_blockchain"))).toBe(true))
    expect(queryByTestId("trophies-league-pills")).toBeNull()
    expect(calls.some((u) => u.includes("property="))).toBe(false)
  })
})

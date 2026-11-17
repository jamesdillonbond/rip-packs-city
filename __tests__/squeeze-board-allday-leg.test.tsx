// @vitest-environment jsdom
// The Lock-Rate Squeeze Board's NFL All Day leg (2026-10-27, All Day ↔ Top Shot parity pass 6).
// Route: ?collection=nfl-all-day reads allday_squeeze_board and resolves teams / accent retries against All Day's
// collection row — never Top Shot's; an unknown collection is a 400 that reads nothing; tiers follow All Day's
// vocabulary. Client: the toggle reads the All Day leg; the Top Shot server seed (rows AND KPIs) never shows under
// it — in flight or after a failed read; All Day rows link All Day edition pages; no owner-census column on All Day.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const state: { data: any; error: any; rpc: any; from: string[]; rpcCalls: { name: string; args: any }[] } = { data: [], error: null, rpc: null, from: [], rpcCalls: [] }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b, ilike: () => b, order: () => b, limit: () => b,
    then: (resolve: any) => resolve({ data: state.data, error: state.error }),
  }
  return {
    supabaseAdmin: {
      from: (t: string) => { state.from.push(t); return b },
      rpc: (name: string, args: any) => { state.rpcCalls.push({ name, args }); return Promise.resolve({ data: state.rpc, error: null }) },
    },
  }
})

import { GET } from "@/app/api/public/insights/squeeze/route"
import SqueezeBoardClient from "@/app/insights/squeeze/SqueezeBoardClient"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/squeeze"

beforeEach(() => {
  state.data = []; state.error = null; state.rpc = null; state.from = []; state.rpcCalls = []
  window.history.replaceState({}, "", "/insights/squeeze")
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("GET /api/public/insights/squeeze?collection=nfl-all-day", () => {
  it("reads allday_squeeze_board, never Top Shot's", async () => {
    state.data = [{ external_id: "4582", player_name: "Travis Kelce" }]
    const res = await GET(req(`${BASE}?collection=nfl-all-day`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(state.from).toEqual(["allday_squeeze_board"])
    expect(body.meta.source).toBe("allday_squeeze_board")
    expect(body.meta.collection).toBe("nfl-all-day")
  })

  it("no collection still means Top Shot", async () => {
    await GET(req(BASE))
    expect(state.from).toEqual(["topshot_squeeze_board"])
  })

  it("resolves a team against All Day's collection row", async () => {
    state.rpc = { status: "one", current_name: "Kansas City Chiefs", names: [{ team_name: "Kansas City Chiefs" }] }
    await GET(req(`${BASE}?collection=nfl-all-day&team=chiefs`))
    const call = state.rpcCalls.find((c) => c.name === "resolve_team_name")
    expect(call?.args.p_collection_id).toBe(ALLDAY)
  })

  it("All Day tiers: UNCOMMON is valid, FANDOM is a 400", async () => {
    expect((await GET(req(`${BASE}?collection=nfl-all-day&tier=uncommon`))).status).toBe(200)
    expect((await GET(req(`${BASE}?collection=nfl-all-day&tier=fandom`))).status).toBe(400)
    expect((await GET(req(`${BASE}?tier=uncommon`))).status).toBe(400)
  })

  it("an unknown collection is a 400 that reads nothing", async () => {
    for (const c of ["candy_mlb", "disney-pinnacle", "__proto__", ""]) {
      expect((await GET(req(`${BASE}?collection=${encodeURIComponent(c)}`))).status).toBe(400)
    }
    expect(state.from).toEqual([])
  })
})

function row(over: Record<string, unknown>) {
  return {
    edition_id: "e", external_id: "141:1", player_name: "P", set_name: "Base Set",
    tier: "COMMON", circulation: 1000, locked: 100, burned: 10, lock_pct: 10, burn_pct: 1,
    squeeze_pct: 60, effectively_buyable: 500, low_ask: 20, fmv_usd: 30, confidence: null,
    game_date: null, thumbnail_url: null, top5_share_pct: 12.5, holders: 40, ...over,
  }
}
const seed = [row({ edition_id: "ts", external_id: "141:2", player_name: "Victor Wembanyama", locked: 777, squeeze_pct: 81 })]
const adRows = [row({ edition_id: "ad", external_id: "4582", player_name: "Travis Kelce", tier: "RARE", circulation: 50, locked: 12, burned: 36, squeeze_pct: 96, effectively_buyable: 2, top5_share_pct: null, holders: null })]

function stub(squeeze: (url: string) => Promise<unknown>) {
  const fn = vi.fn((url: string) => {
    if (String(url).includes("/api/public/insights/squeeze")) return squeeze(String(url))
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
  vi.stubGlobal("fetch", fn)
  return fn
}
const okBody = (rows: unknown[]) => Promise.resolve({ ok: true, json: async () => ({ rows, meta: { fetched_at: "2026-10-27T23:00:00Z", total_rows: rows.length } }) })

describe("SqueezeBoardClient — NFL All Day toggle", () => {
  it("reads the All Day leg, links All Day edition pages, hides the census column", async () => {
    const fn = stub(() => okBody(adRows))
    const { getByTestId, container } = render(<SqueezeBoardClient initialRows={seed as any} initialFetchedAt="2026-10-27T22:00:00Z" />)
    fireEvent.click(getByTestId("sq-collection-nfl-all-day"))
    await waitFor(() => expect(container.textContent).toContain("Travis Kelce"))
    expect(fn.mock.calls.some((c) => String(c[0]).includes("collection=nfl-all-day"))).toBe(true)
    expect(container.textContent).not.toContain("Victor Wembanyama")
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/nfl-all-day/edition/4582")
    expect(hrefs.some((h) => h?.startsWith("/nba-top-shot/"))).toBe(false)
    expect(container.querySelector('[data-testid="top5-share"]')).toBeNull()
    expect(container.textContent).not.toContain("Top 5 hold")
    expect(container.textContent).toContain("UNCOMMON")
    expect(container.textContent).not.toContain("FANDOM")
    expect(container.textContent).toContain("NFL All Day's marketplace shows you")
    expect(window.location.search).toContain("collection=nfl-all-day")
  })

  it("a ?collection=nfl-all-day URL never shows the Top Shot seed or its KPIs while the read is in flight", async () => {
    window.history.replaceState({}, "", "/insights/squeeze?collection=nfl-all-day")
    let release: () => void = () => {}
    stub(() => new Promise((r) => { release = () => r({ ok: true, json: async () => ({ rows: adRows, meta: { fetched_at: "x", total_rows: 1 } }) }) }))
    const { container } = render(<SqueezeBoardClient initialRows={seed as any} initialFetchedAt="2026-10-27T22:00:00Z" />)
    await waitFor(() => expect(container.textContent).toContain("Loading"))
    expect(container.textContent).not.toContain("Victor Wembanyama")
    expect(container.textContent).not.toContain("777")
    release()
    await waitFor(() => expect(container.textContent).toContain("Travis Kelce"))
  })

  it("a failed All Day read says so and shows none of Top Shot's rows or KPIs", async () => {
    window.history.replaceState({}, "", "/insights/squeeze?collection=nfl-all-day")
    stub(() => Promise.resolve({ ok: false, status: 503 }))
    const { container } = render(<SqueezeBoardClient initialRows={seed as any} initialFetchedAt="2026-10-27T22:00:00Z" />)
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load/))
    expect(container.textContent).not.toContain("Victor Wembanyama")
    expect(container.textContent).not.toContain("777")
    expect(container.textContent).not.toMatch(/Median squeeze\s*81%/)
  })

  it("back to Top Shot refetches Top Shot's rows and drops the URL param", async () => {
    stub((u) => okBody(u.includes("nfl-all-day") ? adRows : [row({ edition_id: "ts2", player_name: "Back On Top Shot" })]))
    const { getByTestId, container } = render(<SqueezeBoardClient initialRows={seed as any} initialFetchedAt="2026-10-27T22:00:00Z" />)
    fireEvent.click(getByTestId("sq-collection-nfl-all-day"))
    await waitFor(() => expect(container.textContent).toContain("Travis Kelce"))
    fireEvent.click(getByTestId("sq-collection-nba-top-shot"))
    await waitFor(() => expect(container.textContent).toContain("Back On Top Shot"))
    expect(window.location.search).not.toContain("collection")
    expect(container.textContent).toContain("Top 5 hold")
  })
})

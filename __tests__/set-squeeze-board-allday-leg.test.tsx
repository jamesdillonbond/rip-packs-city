// @vitest-environment jsdom
// The Set Squeeze Leaderboard's NFL All Day leg (2026-10-27, All Day ↔ Top Shot parity pass 7).
// Route: ?collection=nfl-all-day reads allday_set_squeeze_board only; unknown collection → 400 reading nothing;
// All Day tier vocabulary. Client: the toggle reads the All Day leg; Top Shot's seed never shows under it (in flight
// or failed); All Day rows link All Day set pages and the All Day legs of the squeeze / first-mint boards.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

const state: { from: string[] } = { from: [] }
vi.mock("@/lib/supabase", () => {
  const b: any = { select: () => b, eq: () => b, order: () => b, limit: () => b, then: (r: any) => r({ data: [], error: null }) }
  return { supabaseAdmin: { from: (t: string) => { state.from.push(t); return b } } }
})

import { GET } from "@/app/api/public/insights/set-squeeze/route"
import SetSqueezeBoardClient from "@/app/insights/set-squeeze/SetSqueezeBoardClient"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/set-squeeze"

beforeEach(() => { state.from = []; window.history.replaceState({}, "", "/insights/set-squeeze") })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("GET /api/public/insights/set-squeeze?collection=", () => {
  it("nfl-all-day reads allday_set_squeeze_board only", async () => {
    const res = await GET(req(`${BASE}?collection=nfl-all-day`))
    expect(res.status).toBe(200)
    expect(state.from).toEqual(["allday_set_squeeze_board"])
    expect((await res.json()).meta.collection).toBe("nfl-all-day")
  })
  it("no collection still means Top Shot", async () => {
    await GET(req(BASE))
    expect(state.from).toEqual(["topshot_set_squeeze_board"])
  })
  it("All Day tiers: UNCOMMON ok, FANDOM 400", async () => {
    expect((await GET(req(`${BASE}?collection=nfl-all-day&set_tier=uncommon`))).status).toBe(200)
    expect((await GET(req(`${BASE}?collection=nfl-all-day&set_tier=fandom`))).status).toBe(400)
  })
  it("an unknown collection is a 400 that reads nothing", async () => {
    for (const c of ["candy_mlb", "__proto__", ""]) expect((await GET(req(`${BASE}?collection=${encodeURIComponent(c)}`))).status).toBe(400)
    expect(state.from).toEqual([])
  })
})

const row = (o: Record<string, unknown>) => ({
  set_id: "s", set_name: "Base Set", series: 8, set_tier: "COMMON", editions_covered: 10, avg_squeeze_pct: 70,
  median_squeeze_pct: 70, max_squeeze_pct: 90, min_squeeze_pct: 50, total_circ: 1000, total_locked: 600, total_burned: 100,
  total_buyable: 300, avg_fmv_usd: 5, fmv_covered_editions: 10, ...o,
})
const seed = [row({ set_id: "ts", set_name: "Rookie Revelation", total_locked: 4242 })]
const ad = [row({ set_id: "ad", set_name: "NFL Draft", series: 9, avg_squeeze_pct: 71.3 })]

function stub(fn: (u: string) => Promise<unknown>) {
  const f = vi.fn((u: string) => fn(String(u)))
  vi.stubGlobal("fetch", f)
  return f
}
const ok = (rows: unknown[]) => Promise.resolve({ ok: true, json: async () => ({ rows, meta: { fetched_at: "2026-10-27T23:00:00Z", total_rows: rows.length } }) })

describe("SetSqueezeBoardClient — NFL All Day toggle", () => {
  it("reads the All Day leg and links All Day pages and legs", async () => {
    const f = stub(() => ok(ad))
    const { getByTestId, container } = render(<SetSqueezeBoardClient initialRows={seed as any} initialFetchedAt="2026-10-27T22:00:00Z" />)
    fireEvent.click(getByTestId("ss-collection-nfl-all-day"))
    await waitFor(() => expect(container.textContent).toContain("NFL Draft"))
    expect(String(f.mock.calls[0][0])).toContain("collection=nfl-all-day")
    expect(container.textContent).not.toContain("Rookie Revelation")
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "")
    expect(hrefs).toContain("/nfl-all-day/set/nfl-draft")
    expect(hrefs).toContain("/insights/squeeze?collection=nfl-all-day&set=NFL%20Draft")
    expect(hrefs).toContain("/insights/first-mint?collection=nfl-all-day&set=NFL%20Draft")
    expect(hrefs.some((h) => h.startsWith("/nba-top-shot/"))).toBe(false)
    expect(container.textContent).toContain("UNCOMMON")
    expect(container.textContent).not.toContain("FANDOM")
    expect(window.location.search).toContain("collection=nfl-all-day")
  })

  it("a ?collection=nfl-all-day URL never shows Top Shot's seed while in flight, nor after a failed read", async () => {
    window.history.replaceState({}, "", "/insights/set-squeeze?collection=nfl-all-day")
    stub(() => Promise.resolve({ ok: false, status: 503 }))
    const { container } = render(<SetSqueezeBoardClient initialRows={seed as any} initialFetchedAt="2026-10-27T22:00:00Z" />)
    expect(container.textContent).not.toContain("Rookie Revelation")
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load/))
    expect(container.textContent).not.toContain("Rookie Revelation")
    expect(container.textContent).not.toContain("4,242")
  })
})

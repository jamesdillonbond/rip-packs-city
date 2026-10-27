// @vitest-environment jsdom
// The Rookie Index carries the 2025 NFL class on NFL All Day (2026-10-26, All Day ↔ Top Shot parity pass 5):
// `class=nfl-2025` reads allday_2025_rookie_index / _cohort_stats and nothing of Top Shot's; the board's NFL tab
// reads it live (it is not in the server seed), links All Day player pages, offers no Top Shot squeeze link,
// and never shows the Top Shot class's rows under the NFL tab — not while the read is in flight, not after it fails.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

const tables: Record<string, { data: any; error: any }> = {}
const fromCalls: string[] = []

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    fromCalls.push(table)
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b, eq: () => b, gte: () => b, order: () => b, limit: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  const admin: any = { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/rookies/route"
import RookiesBoardClient, { type ApiResponse } from "@/app/insights/rookies/RookiesBoardClient"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/rookies"

const row = (player_name: string, extra: Record<string, unknown> = {}) => ({
  player_name, edition_count: 4, sales_30d: 1, gmv_30d: 75, avg_price_30d: 75, max_sale_30d: 75,
  total_locked: 0, total_burned: 0, total_circ: 654, cohort_squeeze_pct: 0, avg_lock_rate_pct: 0,
  mint_one_eds_with_history: 0, max_mint_one_sale_usd: null, ...extra,
})
const stats = { rookie_count: 1, total_sales_30d: 1, total_gmv_30d: 75, avg_price_active: 75, rookies_with_activity_30d: 1, rookies_with_mint_one_sale: 0, top_mint_one_sale: null }
const initial: ApiResponse = {
  meta: { fetched_at: "2026-10-26T05:00:00Z" },
  cohort_stats: stats,
  rows: [row("Cooper Flagg")],
  class_2026: { cohort_stats: stats, rows: [row("Darryn Peterson")] },
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  fromCalls.length = 0
  window.history.replaceState({}, "", "/insights/rookies")
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("GET /api/public/insights/rookies?class=nfl-2025", () => {
  it("reads only the All Day views", async () => {
    tables.allday_2025_rookie_index = { data: [row("Ashton Jeanty")], error: null }
    tables.topshot_2025_rookie_index = { data: [row("Cooper Flagg")], error: null }
    const res = await GET(req(`${base}?class=nfl-2025`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.map((r: any) => r.player_name)).toEqual(["Ashton Jeanty"])
    expect(body.meta.filters.class).toBe("nfl-2025")
    expect(fromCalls.sort()).toEqual(["allday_2025_rookie_cohort_stats", "allday_2025_rookie_index"])
  })

  it("a class that only looks like one is refused, never templated into a view name", async () => {
    for (const c of ["nfl-2026", "__proto__", "2025_rookie_index;", "constructor"]) {
      const res = await GET(req(`${base}?class=${encodeURIComponent(c)}`))
      expect(res.status).toBe(400)
    }
    expect(fromCalls).toEqual([])
  })
})

describe("RookiesBoardClient NFL 2025 tab", () => {
  const nfl: ApiResponse = {
    meta: { fetched_at: "2026-10-26T05:40:00Z", filters: { class: "nfl-2025" } },
    cohort_stats: { ...stats, rookie_count: 109 },
    rows: [row("Ashton Jeanty", { mint_one_eds_with_history: 2, max_mint_one_sale_usd: 1538.47 })],
  }

  it("reads the class live and links All Day player pages", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: async () => nfl } as Response))
    vi.stubGlobal("fetch", fetchSpy)
    const { getByText, container } = render(<RookiesBoardClient initial={initial} />)
    fireEvent.click(getByText("NFL 2025 class"))
    await waitFor(() => expect(container.textContent).toContain("Ashton Jeanty"))
    expect(fetchSpy.mock.calls.some((c: any[]) => String(c[0]).includes("class=nfl-2025&sort=gmv"))).toBe(true)
    expect(getByText("2025 NFL Rookie Index")).toBeTruthy()
    expect(container.textContent).not.toContain("Cooper Flagg")
    expect(container.querySelector('a[href="/nfl-all-day/player/ashton-jeanty"]')).toBeTruthy()
    expect(container.querySelector('a[href^="/nba-top-shot/"]')).toBeNull()
    expect(container.querySelector('a[href^="/insights/squeeze"]')).toBeNull()
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/insights/first-mint?collection=nfl-all-day&player=Ashton%20Jeanty")
    expect(container.textContent).toContain("All Day's own edition counts")
  })

  it("never shows the Top Shot class under the NFL tab while the read is in flight", async () => {
    let release: () => void = () => {}
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { release = () => r({ ok: true, json: async () => nfl } as Response) })))
    const { getByText, container } = render(<RookiesBoardClient initial={initial} />)
    fireEvent.click(getByText("NFL 2025 class"))
    expect(container.textContent).not.toContain("Cooper Flagg")
    expect(container.textContent).toContain("Loading")
    release()
    await waitFor(() => expect(container.textContent).toContain("Ashton Jeanty"))
  })

  it("a failed NFL read says so and shows no Top Shot rows", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)))
    const { getByText, container } = render(<RookiesBoardClient initial={initial} />)
    fireEvent.click(getByText("NFL 2025 class"))
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load/))
    expect(container.textContent).not.toContain("Cooper Flagg")
    // The KPI row is not the table: the NBA class's cohort figures ($75 GMV) must not sit under the NFL heading.
    expect(container.textContent).not.toContain("$75.00")
  })

  it("?class=nfl-2025 on the page URL opens the NFL tab", async () => {
    window.history.replaceState({}, "", "/insights/rookies?class=nfl-2025")
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: async () => nfl } as Response))
    vi.stubGlobal("fetch", fetchSpy)
    const { container } = render(<RookiesBoardClient initial={initial} />)
    await waitFor(() => expect(container.textContent).toContain("Ashton Jeanty"))
    expect(container.textContent).not.toContain("Cooper Flagg")
  })

  it("back to the 2025 NBA class shows the seed again without a refetch", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: async () => nfl } as Response))
    vi.stubGlobal("fetch", fetchSpy)
    const { getByText, container } = render(<RookiesBoardClient initial={initial} />)
    fireEvent.click(getByText("NFL 2025 class"))
    await waitFor(() => expect(container.textContent).toContain("Ashton Jeanty"))
    const calls = fetchSpy.mock.calls.length
    fireEvent.click(getByText("2025 class"))
    await waitFor(() => expect(container.textContent).toContain("Cooper Flagg"))
    expect(fetchSpy.mock.calls.length).toBe(calls)
    expect(getByText("2025 NBA Rookie Index")).toBeTruthy()
  })
})

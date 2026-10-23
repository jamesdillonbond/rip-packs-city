// @vitest-environment jsdom
// The Rookie Index carries the 2026 class (2026-10-22): the board fetch seeds both
// classes, the API answers ?class=2026 from the 2026 views and refuses an unknown
// class, and the page's class tab shows the seeded 2026 rows without a refetch.
//
// The failure that matters: a failed 2026 read must not render as "no 2026
// rookies" — the fetch reports ok=false and class_2026=null, and the client then
// fetches live instead of trusting an empty seed.

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
import { fetchRookiesDefault } from "@/lib/insights/boards"
import RookiesBoardClient, { type ApiResponse } from "@/app/insights/rookies/RookiesBoardClient"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/rookies"

const row = (player_name: string) => ({
  player_name, edition_count: 4, sales_30d: 1, gmv_30d: 75, avg_price_30d: 75, max_sale_30d: 75,
  total_locked: 0, total_burned: 0, total_circ: 654, cohort_squeeze_pct: 0, avg_lock_rate_pct: 0,
  mint_one_eds_with_history: 0, max_mint_one_sale_usd: null,
})

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  fromCalls.length = 0
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("fetchRookiesDefault seeds both classes", () => {
  it("carries the 2026 class beside the 2025 rows", async () => {
    tables.topshot_2025_rookie_index = { data: [row("Cooper Flagg")], error: null }
    tables.topshot_2026_rookie_index = { data: [row("Darryn Peterson")], error: null }
    tables.topshot_2026_rookie_cohort_stats = { data: [{ rookie_count: 1 }], error: null }
    const res = await fetchRookiesDefault()
    expect(res.ok).toBe(true)
    expect(res.payload.class_2026?.rows).toHaveLength(1)
    expect(res.payload.class_2026?.cohort_stats).toEqual({ rookie_count: 1 })
    expect(res.rowCount).toBe(2)
  })

  it("a failed 2026 read is ok=false and class_2026=null, never an empty class", async () => {
    tables.topshot_2025_rookie_index = { data: [row("Cooper Flagg")], error: null }
    tables.topshot_2026_rookie_index = { data: null, error: { message: "timeout" } }
    const res = await fetchRookiesDefault()
    expect(res.ok).toBe(false)
    expect(res.payload.class_2026).toBeNull()
    expect(res.payload.meta.fetched_at).toBeNull()
    expect(res.error).toContain("topshot_2026_rookie_index")
  })
})

describe("GET /api/public/insights/rookies?class=", () => {
  it("class=2026 reads only the 2026 views", async () => {
    tables.topshot_2026_rookie_index = { data: [row("Darryn Peterson")], error: null }
    const res = await GET(req(`${base}?class=2026`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows[0].player_name).toBe("Darryn Peterson")
    expect(body.meta.filters.class).toBe("2026")
    expect(fromCalls.sort()).toEqual(["topshot_2026_rookie_cohort_stats", "topshot_2026_rookie_index"])
  })

  it("no class param still answers the 2025 class", async () => {
    await GET(req(base))
    expect(fromCalls.sort()).toEqual(["topshot_2025_rookie_cohort_stats", "topshot_2025_rookie_index"])
  })

  it("an unknown class is a 400, never a silent 2025 answer", async () => {
    const res = await GET(req(`${base}?class=2024`))
    expect(res.status).toBe(400)
    expect(fromCalls).toEqual([])
  })
})

describe("RookiesBoardClient class tab", () => {
  const initial: ApiResponse = {
    meta: { fetched_at: "2026-10-23T05:00:00Z" },
    cohort_stats: { rookie_count: 1, total_sales_30d: 1, total_gmv_30d: 75, avg_price_active: 75, rookies_with_activity_30d: 1, rookies_with_mint_one_sale: 0, top_mint_one_sale: null },
    rows: [row("Cooper Flagg")],
    class_2026: {
      cohort_stats: { rookie_count: 1, total_sales_30d: 1, total_gmv_30d: 75, avg_price_active: 75, rookies_with_activity_30d: 1, rookies_with_mint_one_sale: 0, top_mint_one_sale: null },
      rows: [row("Darryn Peterson")],
    },
  }

  it("shows the seeded 2026 rows without a refetch", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response))
    vi.stubGlobal("fetch", fetchSpy)
    const { getByText, queryByText, getAllByText } = render(<RookiesBoardClient initial={initial} />)
    expect(queryByText("Darryn Peterson")).toBeNull()
    fireEvent.click(getByText("2026 class"))
    await waitFor(() => expect(getAllByText("Darryn Peterson").length).toBeGreaterThan(0))
    expect(getByText("2026 NBA Rookie Index")).toBeTruthy()
    expect(queryByText("Cooper Flagg")).toBeNull()
    expect(fetchSpy.mock.calls.some((c: any[]) => String(c[0]).includes("/api/public/insights/rookies"))).toBe(false)
  })

  it("a failed 2026 seed fetches the class live instead of showing it empty", async () => {
    const live: ApiResponse = { meta: initial.meta, cohort_stats: null, rows: [row("Cameron Boozer")] }
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: async () => live } as Response))
    vi.stubGlobal("fetch", fetchSpy)
    const { getByText, getAllByText } = render(<RookiesBoardClient initial={{ ...initial, class_2026: null }} />)
    fireEvent.click(getByText("2026 class"))
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some((c: any[]) => String(c[0]).includes("class=2026&sort=gmv"))).toBe(true),
    )
    await waitFor(() => expect(getAllByText("Cameron Boozer").length).toBeGreaterThan(0))
  })
})

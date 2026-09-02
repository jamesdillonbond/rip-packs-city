import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/overview-stats. Mocks @/lib/supabase's
// supabaseAdmin: chained .from().select().eq() count queries (editions +
// edition_fmv_current HIGH — distinct latest-per-edition, NOT raw fmv_snapshots
// history) plus two rpc() calls (get_market_pulse_all for the 24h
// volume, get_fmv_movers for movers). Pins the invalid-collection guard (200
// zeros, DB untouched) and one mocked happy path (standard collection) that
// asserts totals, HIGH-confidence count, resolved 24h volume, and movers.

const state = {
  editionsCount: 0 as number | null,
  highConfCount: 0 as number | null,
  marketPulse: [] as any[],
  movers: [] as any[],
  /** Every table the route actually read, in order. */
  tablesRead: [] as string[],
}

vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    state.tablesRead.push(table)
    const result = () => {
      if (table === "editions") return { count: state.editionsCount, error: null }
      if (table === "edition_fmv_current") return { count: state.highConfCount, error: null }
      return { count: 0, error: null }
    }
    const b: any = {
      select: () => b,
      eq: () => b,
      then: (resolve: any) => resolve(result()),
    }
    return b
  }
  const admin: any = {
    from: (t: string) => builder(t),
    rpc: async (name: string) => {
      if (name === "get_market_pulse_all") return { data: state.marketPulse, error: null }
      if (name === "get_fmv_movers") return { data: state.movers, error: null }
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/overview-stats/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.editionsCount = 0
  state.highConfCount = 0
  state.marketPulse = []
  state.movers = []
  state.tablesRead = []
})

describe("GET /api/overview-stats", () => {
  it("returns 200 zeros for an unknown collection (DB untouched)", async () => {
    const res = await GET(req("https://t/api/overview-stats?collection=not-a-real-collection"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ totalEditions: 0, highConfCount: 0, volume24h: 0, movers: [] })
  })

  it("returns totals, HIGH count, 24h volume and movers for a standard collection", async () => {
    state.editionsCount = 19126
    state.highConfCount = 5232
    state.marketPulse = [
      { slug: "nba_top_shot", sales_24h: 40, volume_24h: 1234.5 },
      { slug: "nfl_all_day", sales_24h: 3, volume_24h: 99 },
    ]
    state.movers = [{ edition_id: "u1", delta_pct: 12.3 }]

    const res = await GET(req("https://t/api/overview-stats?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalEditions).toBe(19126)
    expect(body.highConfCount).toBe(5232)
    // volume24h resolves via the dbSlug (nba_top_shot) row in the market pulse.
    expect(body.volume24h).toBe(1234.5)
    expect(body.movers).toEqual([{ edition_id: "u1", delta_pct: 12.3 }])
    // Sets the SWR cache header on the success path.
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300")
    // 🚨 And it counted the MATERIALISED table, not the DISTINCT ON view. A
    // collection_id qual against `fmv_current` cannot push down and materialises
    // the whole view — measured 1,331,923 buffers / 14,085 ms for this one count,
    // against 909 / 39 ms here. Assert the table, because the count comes back
    // identical either way: the mock returns 5232 for whichever read fires, so
    // nothing about the RESPONSE can tell the two apart.
    expect(state.tablesRead).toContain("edition_fmv_current")
    expect(state.tablesRead).not.toContain("fmv_current")
  })

  it("defaults to nba-top-shot when no collection param is given", async () => {
    state.editionsCount = 100
    const res = await GET(req("https://t/api/overview-stats"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalEditions).toBe(100)
  })
})

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
  pulseError: null as any,
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
      if (name === "get_market_pulse_all") return { data: state.pulseError ? null : state.marketPulse, error: state.pulseError }
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
  state.pulseError = null
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

    // ⭐ ADDED 2026-09-20 — the four non-answers are NULL, never a measured $0.
    // `countOrNull` in this route already states the rule ("a count we could not
    // read is null, never 0") and getVolume24hFromPulse was breaking it in four
    // places at once.
  })

  it("publishes volume24h as NULL when the collection is ABSENT from the pulse payload", async () => {
    // 🚨 THE CASE THAT SURFACED THIS, and it is not an outage. get_market_pulse_all
    // carried a hardcoded slug list; a collection missing from it made
    // rows.find(...) undefined, and `?? 0` turned "not in the list" into
    // "traded $0 in 24h". Candy MLB was exactly that until 2026-09-20 while
    // trading 129 times a day.
    state.editionsCount = 125
    state.highConfCount = 75
    state.marketPulse = [{ slug: "nba_top_shot", sales_24h: 40, volume_24h: 1234.5 }]

    const res = await GET(req("https://t/api/overview-stats?collection=candy-mlb"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.volume24h).toBeNull()
    // ⛔ Specifically NOT 0 — that is the whole point of the assertion.
    expect(body.volume24h).not.toBe(0)
    // The independent stats still answer; a missing pulse row zeroes nothing else.
    expect(body.totalEditions).toBe(125)
    expect(body.highConfCount).toBe(75)
  })

  it("publishes volume24h as NULL when the pulse read FAILS", async () => {
    state.editionsCount = 19126
    state.highConfCount = 5232
    state.pulseError = { message: "pulse boom" }

    const res = await GET(req("https://t/api/overview-stats?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.volume24h).toBeNull()
    expect(body.volume24h).not.toBe(0)
    // ⚠ The resilient fan-out's own promise: a failed pulse can never zero the
    // edition + confidence counts.
    expect(body.totalEditions).toBe(19126)
    expect(body.highConfCount).toBe(5232)
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

import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/market-pulse. The handler is a
// thin wrapper over fetchMarketPulse(supabaseAdmin); mock @/lib/market-pulse-board
// (and @/lib/supabase so the admin client is never really constructed). No auth
// guard — pins the happy path and the thrown-error → 500 path.

const state: { rows: any; err: Error | null } = { rows: [], err: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/market-pulse-board", () => ({
  fetchMarketPulse: async () => { if (state.err) throw state.err; return state.rows },
}))

import { GET } from "@/app/api/public/insights/market-pulse/route"

beforeEach(() => { state.rows = []; state.err = null })

describe("GET /api/public/insights/market-pulse", () => {
  it("returns the pulse rows on the happy path", async () => {
    state.rows = [{ collection: "nba_top_shot", volume_24h: 12345 }]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual(state.rows)
    expect(body.meta.source).toBe("get_market_pulse_windows")
  })

  it("returns an empty rows array when the board is empty", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("500s when fetchMarketPulse throws", async () => {
    state.err = new Error("pulse down")
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pulse down")
  })

  it("500s and String()-coerces a non-Error throw", async () => {
    state.err = "raw failure" as unknown as Error
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("raw failure")
  })
})

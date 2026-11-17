import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/parallel-premiums. The handler
// parses params (in-route) then wraps fetchParallelPremiums(supabase, opts); mock
// @/lib/parallel-premiums-board (and @/lib/supabase). No hard 400 guard — the
// param parsers clamp/default — so pins the happy path (incl. filter defaulting)
// and the thrown-error → 500 path.

const state: { rows: any[]; err: Error | null; lastOpts: any } = { rows: [], err: null, lastOpts: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/parallel-premiums-board", () => ({
  fetchParallelPremiums: async (_sb: any, opts: any) => {
    state.lastOpts = opts
    if (state.err) throw state.err
    return state.rows
  },
}))

import { GET } from "@/app/api/public/insights/parallel-premiums/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/parallel-premiums"

beforeEach(() => { state.rows = []; state.err = null; state.lastOpts = null })

describe("GET /api/public/insights/parallel-premiums", () => {
  it("returns rows and echoes normalized filters on the happy path", async () => {
    state.rows = [{ external_id: "1:2::19", premium_mult: 58 }]
    const res = await GET(req(`${base}?parallel=Hexwave&min_premium=2&conf=all&sort=scarcity&limit=25`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.total_rows).toBe(1)
    expect(body.meta.filters).toMatchObject({ parallel: "Hexwave", min_premium: 2, conf: "all", sort: "scarcity", limit: 25 })
    expect(state.lastOpts).toMatchObject({ parallelName: "Hexwave", minPremium: 2, highConfOnly: false, sort: "scarcity", limit: 25 })
  })

  it("defaults invalid min_premium / sort / conf sensibly", async () => {
    const res = await GET(req(`${base}?min_premium=-9&sort=bogus`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.filters.min_premium).toBe(1.5) // invalid → default
    expect(body.meta.filters.sort).toBe("premium") // invalid → default
    expect(body.meta.filters.conf).toBe("high") // default
  })

  it("500s when fetchParallelPremiums throws", async () => {
    state.err = new Error("premiums down")
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("premiums down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})

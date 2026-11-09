import { describe, it, expect, vi, beforeEach } from "vitest"

// /api/ingest/candy-collections-market — the rotating market lane route.

const state = { result: null as any, throws: false, logged: [] as any[], heartbeats: 0 }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (_n: string, args: any) => { state.logged.push(args); return { error: null } } },
}))
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: async () => { state.heartbeats++ } }))
vi.mock("@/lib/chains/solana/normalize", () => ({ candyDiscoveryReady: () => true, CANDY_MLB_SLUG: "candy_mlb" }))
vi.mock("@/lib/candy/collections-market", () => ({
  runCollectionsMarket: async () => { if (state.throws) throw new Error("boom"); return state.result },
}))

import { GET } from "@/app/api/ingest/candy-collections-market/route"

const req = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any
const ok = { ok: true, collections: [{ name: "2022 Leadoff ICONs", sales_seen: 2, error: null, symbol_found_now: false }, { name: "quiet", sales_seen: 0, error: null, symbol_found_now: false }], checked: 90, symbols_found: 4, without_symbol: 3, stats_written: 83, sales_offered: 2, error: null }

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret-for-test-000000000000"
  state.result = ok
  state.throws = false
  state.logged = []
  state.heartbeats = 0
})

describe("/api/ingest/candy-collections-market", () => {
  it("401s without the cron bearer and does no work", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(state.heartbeats).toBe(0)
  })

  it("writes a heartbeat first, runs the lane, and logs what it checked", async () => {
    const res = await GET(req("Bearer cron-secret-for-test-000000000000"))
    expect(res.status).toBe(200)
    expect(state.heartbeats).toBe(1)
    expect(state.logged[0]).toMatchObject({ p_pipeline: "candy-collections-market", p_ok: true, p_rows_found: 90, p_rows_written: 85 })
    expect(state.logged[0].p_extra.sales_offered).toBe(2)
    // Only collections with something to say are listed.
    expect(state.logged[0].p_extra.collections.map((c: any) => c.name)).toEqual(["2022 Leadoff ICONs"])
  })

  it("a run with failed collections logs ok:false with the error, never ok", async () => {
    state.result = { ...ok, ok: false, error: "A: page 3: DAS HTTP 502" }
    const res = await GET(req("Bearer cron-secret-for-test-000000000000"))
    expect(res.status).toBe(207)
    expect(state.logged[0]).toMatchObject({ p_ok: false, p_error: "A: page 3: DAS HTTP 502" })
  })

  it("a thrown run is a 500 and an ok:false run row", async () => {
    state.throws = true
    const res = await GET(req("Bearer cron-secret-for-test-000000000000"))
    expect(res.status).toBe(500)
    expect(state.logged[0].p_ok).toBe(false)
  })
})

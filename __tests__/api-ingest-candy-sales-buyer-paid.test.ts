import { describe, it, expect, vi, beforeEach } from "vitest"

// /api/ingest/candy-sales-buyer-paid — the route that re-prices Candy sales at buyer-paid.

const state = { result: null as any, logged: [] as any[], heartbeats: 0 }
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async (_n: string, a: any) => { state.logged.push(a); return { error: null } } } }))
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: async () => { state.heartbeats++ } }))
vi.mock("@/lib/chains/solana/normalize", () => ({ CANDY_MLB_SLUG: "candy_mlb" }))
vi.mock("@/lib/candy/sale-buyer-paid", () => ({ runCandyBuyerPaid: async () => state.result }))

import { GET } from "@/app/api/ingest/candy-sales-buyer-paid/route"

const req = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any
const AUTH = "Bearer cron-secret-for-test-000000000000"
const base = { ok: true, targets: 10, read: 10, applied: 7, paid_by_buyer: 7, paid_by_seller: 3, errors_recorded: 0, not_found: 0, rate_limited: 0, budget_stopped: false, error: null }

beforeEach(() => { process.env.CRON_SECRET = "cron-secret-for-test-000000000000"; state.result = base; state.logged = []; state.heartbeats = 0 })

describe("/api/ingest/candy-sales-buyer-paid", () => {
  it("401s without the cron bearer", async () => {
    expect((await GET(req())).status).toBe(401)
    expect(state.heartbeats).toBe(0)
  })
  it("logs rows_written as sales actually re-priced", async () => {
    const res = await GET(req(AUTH))
    expect(res.status).toBe(200)
    expect(state.logged[0]).toMatchObject({ p_pipeline: "candy-sales-buyer-paid", p_ok: true, p_rows_found: 10, p_rows_written: 7 })
  })
  it("a run where every RPC call was refused is NOT ok, even though nothing threw", async () => {
    state.result = { ...base, read: 0, applied: 0, rate_limited: 5, budget_stopped: true }
    const res = await GET(req(AUTH))
    expect(res.status).toBe(207)
    expect(state.logged[0].p_ok).toBe(false)
    expect(state.logged[0].p_error).toContain("rate_limited")
  })
})

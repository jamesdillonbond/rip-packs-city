import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// /api/ingest/candy-collections-sales — the hourly sales pass route, and its place in the
// schedule: it must run BEFORE the hourly drain that writes what it offers.

const state = { result: null as any, throws: false, logged: [] as any[], heartbeats: 0 }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (_n: string, args: any) => { state.logged.push(args); return { error: null } } },
}))
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: async () => { state.heartbeats++ } }))
vi.mock("@/lib/chains/solana/normalize", () => ({ candyDiscoveryReady: () => true, CANDY_MLB_SLUG: "candy_mlb" }))
vi.mock("@/lib/candy/collections-sales-pass", () => ({
  runCollectionsSalesPass: async () => { if (state.throws) throw new Error("boom"); return state.result },
}))

import { GET } from "@/app/api/ingest/candy-collections-sales/route"

const req = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any
const ok = {
  ok: true, queued: 357, checked: 300, skipped_no_high_water: 1, not_reached: 56, budget_stopped: true,
  sales_seen: 3, sales_offered: 2, high_water_advanced: 40, incomplete: 0, error: null,
  collections: [{ name: "2025 All-Star ICONS", sales_seen: 1, sales_offered: 1, incomplete: false, error: null }, { name: "quiet", sales_seen: 0, incomplete: false, error: null }],
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret-for-test-000000000000"
  state.result = ok
  state.throws = false
  state.logged = []
  state.heartbeats = 0
})

describe("/api/ingest/candy-collections-sales", () => {
  it("401s without the cron bearer and does no work", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(state.heartbeats).toBe(0)
  })

  it("writes a heartbeat first and logs rows_written as sales OFFERED, with the budget stop visible", async () => {
    const res = await GET(req("Bearer cron-secret-for-test-000000000000"))
    expect(res.status).toBe(200)
    expect(state.heartbeats).toBe(1)
    expect(state.logged[0]).toMatchObject({ p_pipeline: "candy-collections-sales", p_ok: true, p_rows_found: 300, p_rows_written: 2 })
    expect(state.logged[0].p_extra).toMatchObject({ budget_stopped: true, not_reached: 56, queued: 357 })
    expect(state.logged[0].p_extra.collections.map((c: any) => c.name)).toEqual(["2025 All-Star ICONS"])
  })

  it("a run with failed collections logs ok:false with the error, never ok", async () => {
    state.result = { ...ok, ok: false, error: "A: ME HTTP 502" }
    const res = await GET(req("Bearer cron-secret-for-test-000000000000"))
    expect(res.status).toBe(207)
    expect(state.logged[0]).toMatchObject({ p_ok: false, p_error: "A: ME HTTP 502" })
  })

  it("a thrown run is a 500 and an ok:false run row", async () => {
    state.throws = true
    const res = await GET(req("Bearer cron-secret-for-test-000000000000"))
    expect(res.status).toBe(500)
    expect(state.logged[0].p_ok).toBe(false)
  })

  it("is scheduled hourly, before the hourly candy-sales-indexer drain that writes what it offers", () => {
    const v = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"))
    const cron = (p: string) => v.crons.find((c: any) => c.path === p)?.schedule
    const pass = cron("/api/ingest/candy-collections-sales")
    const drain = cron("/api/candy-sales-indexer")
    expect(pass).toMatch(/^\d+ \* \* \* \*$/)
    expect(drain).toMatch(/^\d+ \* \* \* \*$/)
    expect(Number(pass.split(" ")[0])).toBeLessThan(Number(drain.split(" ")[0]))
  })
})

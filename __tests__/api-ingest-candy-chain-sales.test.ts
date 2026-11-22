import { describe, it, expect, vi, beforeEach } from "vitest"

// /api/ingest/candy-chain-sales — the route that captures Candy fills settling off Magic Eden.

const state = { result: null as any, logged: [] as any[], heartbeats: 0 }
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async (_n: string, a: any) => { state.logged.push(a); return { error: null } } } }))
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: async () => { state.heartbeats++ } }))
vi.mock("@/lib/chains/solana/normalize", () => ({ CANDY_MLB_SLUG: "candy_mlb" }))
vi.mock("@/lib/candy/chain-sales", () => ({ runCandyChainSales: async () => state.result }))

import { GET } from "@/app/api/ingest/candy-chain-sales/route"

const req = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any
const AUTH = "Bearer cron-secret-for-test-000000000000"
const col = (o: any) => ({ address: "A", name: "n", sigs: 3, fetched: 2, fills: 0, offered: 0, error: null, ...o })
const base = {
  ok: true, queued: 3, checked: 3, not_reached: 0, sigs_read: 9, tx_fetched: 6, fills_seen: 2, fills_offered: 1, fills_known: 1,
  take_bids_seen: 0, unknown_ix: [], failed: 0, error: null,
  collections: [col({ address: "A", fills: 2, offered: 1 }), col({ address: "B" }), col({ address: "C" })],
}

beforeEach(() => { process.env.CRON_SECRET = "cron-secret-for-test-000000000000"; state.result = base; state.logged = []; state.heartbeats = 0 })

describe("/api/ingest/candy-chain-sales", () => {
  it("401s without the cron bearer, before any work", async () => {
    expect((await GET(req())).status).toBe(401)
    expect(state.heartbeats).toBe(0)
  })
  it("writes a heartbeat, logs rows_written as fills newly offered, keeps only collections with a fill or a failure", async () => {
    const res = await GET(req(AUTH))
    expect(res.status).toBe(200)
    expect(state.heartbeats).toBe(1)
    expect(state.logged[0]).toMatchObject({ p_pipeline: "candy-chain-sales", p_ok: true, p_rows_found: 2, p_rows_written: 1 })
    expect(state.logged[0].p_extra.collections.map((c: any) => c.address)).toEqual(["A"])
  })
  it("a failed collection makes the run NOT ok and is kept in the log", async () => {
    state.result = { ...base, ok: false, failed: 1, error: "1 collection(s) failed; first: boom", collections: [...base.collections, col({ address: "D", error: "boom" })] }
    const res = await GET(req(AUTH))
    expect(res.status).toBe(207)
    expect(state.logged[0].p_ok).toBe(false)
    expect(state.logged[0].p_extra.collections.map((c: any) => c.address)).toEqual(["A", "D"])
  })
})

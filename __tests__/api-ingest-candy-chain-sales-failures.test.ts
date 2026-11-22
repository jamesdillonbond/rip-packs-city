import { describe, it, expect, vi, beforeEach } from "vitest"

// /api/ingest/candy-chain-sales — the paths the main route test leaves open (2026-11-22 coverage):
// POST runs the same handler; a thrown run is logged ok=false and answered 500; a failed or
// throwing log write never turns a run into an error.

const state = { mode: "ok" as "ok" | "throw", log: "ok" as "ok" | "err" | "throw", logged: [] as any[] }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_n: string, a: any) => {
      state.logged.push(a)
      if (state.log === "throw") throw new Error("log down")
      return { error: state.log === "err" ? { message: "log refused" } : null }
    },
  },
}))
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: async () => {} }))
vi.mock("@/lib/chains/solana/normalize", () => ({ CANDY_MLB_SLUG: "candy_mlb" }))
vi.mock("@/lib/candy/chain-sales", () => ({
  runCandyChainSales: async () => {
    if (state.mode === "throw") throw new Error("rpc exploded")
    return { ok: true, fills_seen: 0, fills_offered: 0, error: null, collections: [] }
  },
}))

import { POST } from "@/app/api/ingest/candy-chain-sales/route"

const req = () => ({ headers: new Headers({ authorization: "Bearer ingest-token-for-test-0000000000" }) }) as any

beforeEach(() => {
  delete process.env.CRON_SECRET
  process.env.INGEST_SECRET_TOKEN = "ingest-token-for-test-0000000000"
  state.mode = "ok"; state.log = "ok"; state.logged = []
})

describe("/api/ingest/candy-chain-sales — failure paths", () => {
  it("POST with the operator token runs the lane", async () => {
    expect((await POST(req())).status).toBe(200)
    expect(state.logged[0]).toMatchObject({ p_pipeline: "candy-chain-sales", p_ok: true })
  })
  it("a thrown run is logged ok=false and answered 500", async () => {
    state.mode = "throw"
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(state.logged[0]).toMatchObject({ p_ok: false, p_error: "rpc exploded" })
  })
  it("a refused or throwing log write does not fail the run", async () => {
    state.log = "err"
    expect((await POST(req())).status).toBe(200)
    state.log = "throw"
    expect((await POST(req())).status).toBe(200)
  })
})

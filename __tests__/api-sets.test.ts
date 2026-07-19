import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/sets (DB-driven Top Shot set tracker).
// Pre-DB guard: 400 "wallet param required" when ?wallet is absent. Past that it
// resolves the wallet and calls the get_topshot_set_progress /
// get_topshot_set_detail RPCs on supabaseAdmin — both mocked here. RPC errors are
// `throw error`n and surface as 500 with the error message.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))
vi.mock("@/lib/chains/flow/flow-resolve", () => ({
  resolveToFlowAddress: async (w: string) => w,
}))

import { GET } from "@/app/api/sets/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/sets", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/sets"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  it("returns an empty progress payload when the RPC has no sets", async () => {
    state.data = null // null payload → sets = []
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc")
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
  })

  it("500s (with the error message) when the progress RPC errors", async () => {
    state.error = { message: "db exploded" }
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db exploded")
  })
})

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

  it("500s WITHOUT leaking the driver message when the progress RPC errors", async () => {
    // This test used to assert the leak ("expect(body.error).toBe('db exploded')").
    // The sets page renders body.error verbatim under an "ERROR" heading, so
    // whatever the DB said went straight onto the flagship Set Tracker — which
    // under saturation meant "canceling statement due to statement timeout" in
    // front of anonymous visitors (deep-audit D3).
    state.error = { message: "db exploded" }
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("Failed to load sets.")
    expect(body.error).not.toContain("db exploded")
    expect(body.code).toBe("internal")
  })

  it("503s with retryable copy on a statement timeout, not a raw Postgres string", async () => {
    // 57014 is the code the saturated pooler actually returns.
    state.error = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET(req("https://t/api/sets?wallet=0xabc"))
    // 503 + Retry-After, not 500: transient capacity, and it keeps the route out
    // of the hard-5xx budget that pages on genuine breakage.
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("60")
    const body = await res.json()
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
    expect(body.error).not.toMatch(/canceling statement|statement timeout/i)
    expect(body.error).toMatch(/try again/i)
  })
})

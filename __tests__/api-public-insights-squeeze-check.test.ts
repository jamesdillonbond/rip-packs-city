import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/squeeze-check. Wraps the
// get_wallet_squeeze_exposure RPC. Pins the pre-DB param guards (missing wallet /
// non-Flow-address → 400) plus the happy and rpc-error (500) paths.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/public/insights/squeeze-check/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/squeeze-check"

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/public/insights/squeeze-check", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req(BASE))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param is required")
  })

  it("400s when wallet is not a Flow address", async () => {
    const res = await GET(req(`${BASE}?wallet=0x123`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Flow address")
  })

  it("returns the exposure summary on the happy path", async () => {
    state.data = { liquid_usd: 500, buckets: [] }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("get_wallet_squeeze_exposure")
    expect(body.summary).toEqual({ liquid_usd: 500, buckets: [] })
  })

  it("500s on an RPC error", async () => {
    state.error = { message: "rpc boom" }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("rpc boom")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})

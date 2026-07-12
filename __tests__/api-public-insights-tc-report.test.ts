import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/tc-report. Wraps the
// get_wallet_tc_report RPC. Pins the pre-DB param guards (missing wallet /
// non-Flow-address → 400) plus the happy and rpc-error (500) paths.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/public/insights/tc-report/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/tc-report"

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/public/insights/tc-report", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req(BASE))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param is required")
  })

  it("400s when wallet is not a Flow address", async () => {
    const res = await GET(req(`${BASE}?wallet=nonsense`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Flow address")
  })

  it("returns the report on the happy path", async () => {
    state.data = { rollup: { total_fmv: 1234 } }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("get_wallet_tc_report")
    expect(body.report).toEqual({ rollup: { total_fmv: 1234 } })
  })

  it("500s on an RPC error", async () => {
    state.error = { message: "rpc down" }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("rpc down")
  })
})

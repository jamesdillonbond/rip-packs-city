import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/pulse/24h. No guards; thin
// rpcWithRetry(supabaseAdmin, "analytics_pulse_24h") wrapper returning the
// payload verbatim. Pins the happy pass-through and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/analytics/pulse/24h/route"

const req = (url = "https://t/api/analytics/pulse/24h") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/pulse/24h", () => {
  it("returns the rpc payload verbatim", async () => {
    rpc.data = { sales: { sales: 42 }, loans: { originations: 3 } }
    const res = await GET(req("https://t/api/analytics/pulse/24h?collections=allday"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sales: { sales: 42 }, loans: { originations: 3 } })
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pulse_24h_failed")
  })
})

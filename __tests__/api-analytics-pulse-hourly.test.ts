import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/pulse/hourly. No guards; wraps
// analytics_pulse_hourly and returns { rows, hours } with hours clamped to
// 1..168. Pins the happy path (hours echoed + clamped), and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/analytics/pulse/hourly/route"

const req = (url = "https://t/api/analytics/pulse/hourly") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/pulse/hourly", () => {
  it("returns { rows, hours } with hours clamped to the 168 max", async () => {
    rpc.data = [{ bucket: "2026-07-12T00:00:00Z", sales: 1 }]
    const res = await GET(req("https://t/api/analytics/pulse/hourly?hours=999"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([{ bucket: "2026-07-12T00:00:00Z", sales: 1 }])
    expect(body.hours).toBe(168)
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pulse_hourly_failed")
  })
})

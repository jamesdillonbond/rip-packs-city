import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/pulse/activity. No guards;
// wraps analytics_pulse_activity and returns { rows }. Pins the happy path
// (rows echoed), the null→[] empty path, and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/pulse/activity/route"

const req = (url = "https://t/api/analytics/pulse/activity") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/pulse/activity", () => {
  it("wraps the rpc rows under { rows }", async () => {
    rpc.data = [{ kind: "sale", occurred_at: "2026-07-12T00:00:00Z" }]
    const res = await GET(req("https://t/api/analytics/pulse/activity?kinds=sale&limit=10"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([{ kind: "sale", occurred_at: "2026-07-12T00:00:00Z" }])
  })

  it("returns { rows: [] } when the rpc yields null", async () => {
    rpc.data = null
    expect((await (await GET(req())).json()).rows).toEqual([])
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pulse_activity_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pulse_activity_failed")
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sets/summary. No guards; wraps
// analytics_sets_summary and returns the payload verbatim. Pins the happy
// pass-through and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/analytics/sets/summary/route"

const req = (url = "https://t/api/analytics/sets/summary") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/sets/summary", () => {
  it("returns the rpc payload verbatim", async () => {
    rpc.data = { collections: [{ slug: "nba_top_shot", sets: 40 }] }
    const res = await GET(req("https://t/api/analytics/sets/summary?collections=topshot"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ collections: [{ slug: "nba_top_shot", sets: 40 }] })
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sets_summary_failed")
  })
})

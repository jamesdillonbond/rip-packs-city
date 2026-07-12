import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pack-ev-history.
// Thin wrapper over get_pack_ev_history(p_pack_listing_id, p_days). Pins: the
// missing-packListingId 400, the rpc-error 500, and the happy 200 (with the
// days clamp to [1,90], default 14).

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: state.data, error: state.error }) }),
}))

import { GET } from "@/app/api/pack-ev-history/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/pack-ev-history", () => {
  it("400s when packListingId is missing", async () => {
    const res = await GET(req("https://t/api/pack-ev-history"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("packListingId is required")
  })

  it("500s on an rpc error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req("https://t/api/pack-ev-history?packListingId=abc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("returns the history array and echoes the clamped days", async () => {
    state.data = [{ snapshotted_at: "2026-07-12", pack_ev: 5 }]
    const res = await GET(req("https://t/api/pack-ev-history?packListingId=abc&days=200"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.packListingId).toBe("abc")
    expect(body.days).toBe(90) // clamped from 200
    expect(body.history).toHaveLength(1)
  })

  it("defaults days to 14 and returns [] when data is not an array", async () => {
    state.data = null
    const res = await GET(req("https://t/api/pack-ev-history?packListingId=abc"))
    const body = await res.json()
    expect(body.days).toBe(14)
    expect(body.history).toEqual([])
  })
})
